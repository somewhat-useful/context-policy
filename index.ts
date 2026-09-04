/**
 * Per-model compaction policy.
 *
 * pi keeps one global `compaction.reserveTokens` and one global `compaction.keepRecentTokens`
 * for every model. This extension derives both from the model that is currently loaded,
 * triggers compaction on its own threshold, and supplies the summary with its own cut point.
 *
 * The global settings must stay out of the way; see README.md.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { CompactionEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_DIR_NAME,
	convertToLlm,
	DEFAULT_COMPACTION_SETTINGS,
	findCutPoint,
	getAgentDir,
	serializeConversation,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

// pi does not re-export AgentMessage from its entry point, so the message type is taken from the
// one function that returns it.
type ContextMessage = ReturnType<typeof sessionEntryToContextMessages>[number];

interface ModelLimits {
	contextWindow: number;
	maxTokens: number;
}

interface CompactionPolicy {
	/** Tokens withheld from the window so a full-length response still fits. */
	reserveTokens: number;
	/** Context size at which compaction starts. */
	thresholdTokens: number;
	/** Recent conversation kept verbatim; everything older becomes the summary. */
	keepRecentTokens: number;
	/** Output cap for the summarization request. */
	summaryMaxTokens: number;
}

const OUTPUT_HEADROOM = 1.1; // reserve = max output x this
const MIN_RESERVE_TOKENS = 4096;
const MAX_RESERVE_SHARE_OF_WINDOW = 0.3; // ... but never more of the window than this
/** A floor under the cap above, so a small window still gets a reserve worth having. */
const RESERVE_CAP_FLOOR = 2048;
/** Used when a model declares no output limit of its own. */
const ASSUMED_MAX_OUTPUT_TOKENS = 4096;
const KEEP_SHARE_OF_THRESHOLD = 0.35; // kept tail, as a share of the threshold
const MIN_KEEP_TOKENS = 2000;
const MAX_KEEP_TOKENS = 48000; // ceiling on the kept tail, for very large windows
const SUMMARY_SHARE_OF_RESERVE = 0.5;
const MIN_SUMMARY_TOKENS = 1024;
const MAX_SUMMARY_TOKENS = 8192;

function policyFor(model: ModelLimits): CompactionPolicy | undefined {
	const contextWindow = model.contextWindow;
	// Also rejects NaN, which a hand-written model entry can produce.
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
	const output = model.maxTokens > 0 ? model.maxTokens : ASSUMED_MAX_OUTPUT_TOKENS;

	const reserveTokens = Math.min(
		Math.max(Math.round(output * OUTPUT_HEADROOM), MIN_RESERVE_TOKENS),
		Math.max(Math.floor(contextWindow * MAX_RESERVE_SHARE_OF_WINDOW), RESERVE_CAP_FLOOR),
	);
	const thresholdTokens = contextWindow - reserveTokens;
	// Too small to hold back a reply and still keep a worthwhile tail: leave the model to pi.
	if (thresholdTokens <= MIN_KEEP_TOKENS) return undefined;
	const keepRecentTokens = Math.min(
		Math.max(Math.floor(thresholdTokens * KEEP_SHARE_OF_THRESHOLD), MIN_KEEP_TOKENS),
		MAX_KEEP_TOKENS,
	);
	const summaryMaxTokens = Math.min(
		Math.max(Math.floor(reserveTokens * SUMMARY_SHARE_OF_RESERVE), MIN_SUMMARY_TOKENS),
		Math.min(output, MAX_SUMMARY_TOKENS),
	);
	return { reserveTokens, thresholdTokens, keepRecentTokens, summaryMaxTokens };
}

function policyForContext(ctx: ExtensionContext): CompactionPolicy | undefined {
	const model = ctx.model;
	if (!model) return undefined;
	return policyFor({ contextWindow: model.contextWindow, maxTokens: model.maxTokens });
}

// ---------------------------------------------------------------------------
// Cut point
// ---------------------------------------------------------------------------

interface SummarizationRange {
	startIndex: number;
	previousCompaction?: CompactionEntry;
}

/** Everything before the latest compaction boundary is already covered by that summary. */
function summarizationRange(entries: SessionEntry[]): SummarizationRange {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "compaction") continue;
		const keptIndex = entries.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
		return { startIndex: keptIndex >= 0 ? keptIndex : i + 1, previousCompaction: entry };
	}
	return { startIndex: 0 };
}

// ---------------------------------------------------------------------------
// File tracking
// ---------------------------------------------------------------------------

interface FileTouches {
	read: Set<string>;
	modified: Set<string>;
}

interface FileLists {
	readFiles: string[];
	modifiedFiles: string[];
}

function addStrings(target: Set<string>, values: unknown): void {
	if (!Array.isArray(values)) return;
	for (const value of values) {
		if (typeof value === "string") target.add(value);
	}
}

function collectFileTouches(
	messages: ContextMessage[],
	previousCompaction: CompactionEntry | undefined,
): FileTouches {
	const touches: FileTouches = { read: new Set(), modified: new Set() };

	const details = previousCompaction?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
	addStrings(touches.read, details?.readFiles);
	addStrings(touches.modified, details?.modifiedFiles);

	// Only pi's built-in file tools are tracked; custom tools that touch files are invisible here.
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const path = (block.arguments as { path?: unknown } | undefined)?.path;
			if (typeof path !== "string") continue;
			if (block.name === "read") touches.read.add(path);
			else if (block.name === "write" || block.name === "edit") touches.modified.add(path);
		}
	}
	return touches;
}

function toFileLists(touches: FileTouches): FileLists {
	return {
		readFiles: [...touches.read].filter((path) => !touches.modified.has(path)).sort(),
		modifiedFiles: [...touches.modified].sort(),
	};
}

function formatFileLists(lists: FileLists): string {
	const sections: string[] = [];
	if (lists.readFiles.length > 0) sections.push(`<read-files>\n${lists.readFiles.join("\n")}\n</read-files>`);
	if (lists.modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${lists.modifiedFiles.join("\n")}\n</modified-files>`);
	}
	return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

// ---------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Read the conversation and produce the structured summary requested.
Do NOT continue the conversation. Do NOT answer questions asked inside it. Output the summary only.`;

const SUMMARY_FORMAT = `## Goal
[What the user is trying to accomplish. Several items if the session covers several tasks.]

## Constraints & Preferences
- [Constraints, preferences and requirements stated by the user, or "(none)"]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [What prevents progress, or "(none)"]

## Key Decisions
- **[Decision]**: [Why]

## Next Steps
1. [Ordered list of what happens next]

## Critical Context
- [Data, examples and references needed to continue, or "(none)"]

Keep every section concise. Preserve exact file paths, function names, commands and error messages.`;

function buildSummaryPrompt(conversation: string, previousSummary?: string, customInstructions?: string): string {
	const parts = [`<conversation>\n${conversation}\n</conversation>`];
	if (previousSummary) parts.push(`<previous-summary>\n${previousSummary}\n</previous-summary>`);

	const task = previousSummary
		? `The messages above are NEW messages to fold into the existing summary in <previous-summary>.
Preserve everything still relevant from it, move finished items from "In Progress" to "Done", update "Next Steps",
and drop only what no longer matters. Reply with the complete updated summary in this format:

${SUMMARY_FORMAT}`
		: `The messages above are a conversation to summarize. Produce a context checkpoint that another
LLM will use to continue the work, in this exact format:

${SUMMARY_FORMAT}`;

	parts.push(customInstructions ? `${task}\n\nAdditional focus: ${customInstructions}` : task);
	return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Settings check
// ---------------------------------------------------------------------------

interface GlobalCompaction {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

function readSettingsFile(path: string): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function readGlobalCompaction(ctx: ExtensionContext): GlobalCompaction {
	const paths = [join(getAgentDir(), "settings.json")];
	if (ctx.isProjectTrusted()) paths.push(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"));
	const merged: Record<string, unknown> = {};
	for (const path of paths) {
		const compaction = readSettingsFile(path).compaction;
		if (compaction && typeof compaction === "object") Object.assign(merged, compaction);
	}
	return {
		enabled: merged.enabled !== false,
		reserveTokens:
			typeof merged.reserveTokens === "number" ? merged.reserveTokens : DEFAULT_COMPACTION_SETTINGS.reserveTokens,
		keepRecentTokens:
			typeof merged.keepRecentTokens === "number"
				? merged.keepRecentTokens
				: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
	};
}

function settingsWarnings(policy: CompactionPolicy, piSettings: GlobalCompaction): string[] {
	const warnings: string[] = [];
	if (!piSettings.enabled) {
		warnings.push("compaction.enabled is false: pi never compacts, and context-overflow recovery is off too.");
	}
	if (piSettings.reserveTokens >= policy.reserveTokens) {
		warnings.push(
			`compaction.reserveTokens (${piSettings.reserveTokens}) >= policy reserve (${policy.reserveTokens}): ` +
				"pi reaches its own threshold first and this extension has to cancel it every turn. Lower it.",
		);
	}
	if (piSettings.keepRecentTokens > policy.keepRecentTokens) {
		warnings.push(
			`compaction.keepRecentTokens (${piSettings.keepRecentTokens}) > policy keep (${policy.keepRecentTokens}): ` +
				"pi may find nothing to compact before this extension gets to choose a cut point. Lower it.",
		);
	}
	return warnings;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

function formatTokens(tokens: number): string {
	return tokens.toLocaleString("en-US");
}

const CONTINUATION_TYPE = "context-policy/continue";
const CONTINUE_AFTER_COMPACTION =
	"The context was compacted: everything above is a summary plus the most recent messages. " +
	"Continue the task from where you left off, without repeating work already recorded as done.";

export default function contextPolicy(pi: ExtensionAPI) {
	// pi resolves the promise inside ctx.compact()'s own abort() only after agent_settled has been
	// delivered to extensions, so a compaction started from turn_end is still parked when the next
	// handler runs. Without this flag the same trigger compacts twice, concurrently.
	let compactionInFlight = false;
	// Set when compaction cannot help — it failed, or it finished still above the threshold — so
	// neither trigger spends another summarization on it. Cleared as soon as the context is seen
	// back under the threshold, because then something else brought it down and the policy is
	// worth applying again.
	let standDown = false;
	// Repeated identical failures are one condition, not news on every run.
	let lastFailure: string | undefined;

	/** pi rejects with exactly this when the user cancels a compaction with Escape. */
	const CANCELLED = "Compaction cancelled";

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") => {
		if (ctx.hasUI) ctx.ui.notify(`context-policy: ${message}`, level);
	};

	const contextTokens = (ctx: ExtensionContext): number | undefined => {
		const usage = ctx.getContextUsage();
		return usage && usage.tokens !== null ? usage.tokens : undefined;
	};

	/** pi skips its own compaction after an aborted reply; the same applies here. */
	const lastReplyAborted = (ctx: ExtensionContext): boolean => {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (!entry || entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "assistant") continue;
			return message.stopReason === "aborted";
		}
		return false;
	};

	const resumeWork = (ctx: ExtensionContext) => {
		// Compaction aborts the run, and the extension API has no agent.continue(). A custom message
		// with triggerTurn goes through the same entry point as a user prompt and reaches the model
		// as a user-role message, while display: false keeps it out of the transcript.
		pi.sendMessage(
			{ customType: CONTINUATION_TYPE, content: CONTINUE_AFTER_COMPACTION, display: false },
			{ triggerTurn: true, deliverAs: ctx.isIdle() ? undefined : "followUp" },
		);
	};

	const compactNow = (ctx: ExtensionContext, resume: boolean) => {
		if (compactionInFlight) return;
		compactionInFlight = true;
		// pi calls onComplete inside its own try, so a throw here would arrive again as onError.
		let settled = false;

		const settle = (tokensAfter: number | undefined, failure: string | undefined) => {
			if (settled) return;
			settled = true;
			compactionInFlight = false;
			let resumeAfter = resume;
			try {
				if (failure === CANCELLED) {
					// The user stopped this on purpose. Not a failure, and the run they interrupted
					// must stay stopped.
					resumeAfter = false;
					return;
				}
				if (failure !== undefined) {
					standDown = true;
					if (failure !== lastFailure) {
						lastFailure = failure;
						notify(ctx, `compaction failed: ${failure}`, "error");
					}
					return;
				}
				lastFailure = undefined;
				// The model in force now, which is what the next request will use: it may have been
				// switched while the compaction ran.
				const policy = policyForContext(ctx);
				// pi's estimate covers messages only, so it understates the real context by the size of
				// the system prompt. It therefore flags only a compaction that plainly could not help.
				if (policy && tokensAfter !== undefined && tokensAfter >= policy.thresholdTokens) {
					standDown = true;
					notify(ctx, "compaction could not get under the threshold; leaving the rest to pi", "warning");
				}
			} finally {
				// The run is stopped either way; leaving it there would strand the task.
				if (resumeAfter) resumeWork(ctx);
			}
		};

		ctx.compact({
			onComplete: (result) => settle(result?.estimatedTokensAfter, undefined),
			onError: (error) => settle(undefined, error.message),
		});
	};

	/**
	 * The single decision both triggers ask. Returns the policy when compaction is wanted, and
	 * re-arms a stood-down extension the moment the context is back under the threshold.
	 */
	const compactionWanted = (ctx: ExtensionContext): CompactionPolicy | undefined => {
		const policy = policyForContext(ctx);
		const tokens = contextTokens(ctx);
		if (!policy || tokens === undefined) return undefined;
		if (tokens < policy.thresholdTokens) {
			standDown = false;
			return undefined;
		}
		return standDown ? undefined : policy;
	};

	pi.on("session_start", (_event, ctx) => {
		const policy = policyForContext(ctx);
		if (!policy || !ctx.hasUI) return;
		const warnings = settingsWarnings(policy, readGlobalCompaction(ctx));
		if (warnings.length > 0) notify(ctx, warnings.join(" "), "warning");
	});

	// Mid-run guard. pi checks its own threshold only once per user prompt, after the whole tool loop
	// has finished, so a tool-heavy run can cross the threshold and keep going until the provider
	// truncates the reply. turn_end fires after each assistant message and its tool results, which is
	// the only point inside the loop where context can be measured.
	pi.on("turn_end", (event, ctx) => {
		// An empty batch means the run is ending anyway: agent_settled covers it.
		if (event.toolResults.length === 0) return;
		// The batch can also end because the user aborted, and that run must not be restarted.
		if (ctx.signal?.aborted) return;
		if (!compactionWanted(ctx)) return;

		compactNow(ctx, true);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (lastReplyAborted(ctx)) return;
		if (!compactionWanted(ctx)) return;
		compactNow(ctx, false);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		const policy = policyForContext(ctx);
		if (!model || !policy) return;

		// pi's own threshold is stricter than ours: postpone until ours is reached.
		if (event.reason === "threshold") {
			const tokens = ctx.getContextUsage()?.tokens;
			if (typeof tokens === "number" && tokens < policy.thresholdTokens) return { cancel: true };
		}

		const entries = event.branchEntries;
		const range = summarizationRange(entries);
		const cut = findCutPoint(entries, range.startIndex, entries.length, policy.keepRecentTokens);
		const firstKeptEntryId = entries[cut.firstKeptEntryIndex]?.id;
		if (!firstKeptEntryId) return;

		const messages: ContextMessage[] = [];
		for (let i = range.startIndex; i < cut.firstKeptEntryIndex; i++) {
			const entry = entries[i];
			if (!entry || entry.type === "compaction") continue;
			messages.push(...sessionEntryToContextMessages(entry));
		}
		if (messages.length === 0) return;

		const prompt = buildSummaryPrompt(
			serializeConversation(convertToLlm(messages)),
			event.preparation.previousSummary,
			event.customInstructions,
		);

		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
					messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
				},
				{
					maxTokens: policy.summaryMaxTokens,
					signal: event.signal,
					cacheRetention: "none",
					sessionId: uuidv7(),
				},
			);

			// A dropped or truncated stream resolves normally, carrying whatever text arrived.
			// Committing that would discard the summarized range behind half a summary.
			// "toolUse" cannot occur — the request carries no tools — but treating it as a clean stop
			// keeps the test to "did the model finish saying what it had to say".
			if (response.stopReason !== "stop" && response.stopReason !== "toolUse") {
				if (!event.signal.aborted) {
					notify(ctx, `summarization ended with "${response.stopReason}", falling back to pi`, "warning");
				}
				return;
			}

			const summary = response.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n")
				.trim();
			if (!summary) return;

			const lists = toFileLists(collectFileTouches(messages, range.previousCompaction));
			return {
				compaction: {
					summary: summary + formatFileLists(lists),
					firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: response.usage,
					details: lists,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!event.signal.aborted) notify(ctx, `summarization failed (${message}), falling back to pi`, "warning");
			return;
		}
	});

	pi.registerCommand("context-policy", {
		description: "Show the compaction policy computed for the current model",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			const policy = policyForContext(ctx);
			if (!model || !policy) {
				notify(ctx, "no model with a usable context window", "warning");
				return;
			}
			const usage = ctx.getContextUsage();
			const piSettings = readGlobalCompaction(ctx);
			const share = (tokens: number) => `${Math.round((tokens / model.contextWindow) * 100)}%`;

			const lines = [
				`${model.name} (${model.provider}/${model.id})`,
				model.maxTokens > 0
					? `window ${formatTokens(model.contextWindow)}, max output ${formatTokens(model.maxTokens)}`
					: `window ${formatTokens(model.contextWindow)}, no declared output limit ` +
						`(assuming ${formatTokens(ASSUMED_MAX_OUTPUT_TOKENS)})`,
				`compact at ${formatTokens(policy.thresholdTokens)} (${share(policy.thresholdTokens)}), ` +
					`reserve ${formatTokens(policy.reserveTokens)}`,
				`keep ${formatTokens(policy.keepRecentTokens)} recent, summary cap ${formatTokens(policy.summaryMaxTokens)}`,
				usage && usage.tokens !== null
					? `now ${formatTokens(usage.tokens)} (${share(usage.tokens)})`
					: "now unknown (no response since the last compaction)",
				`pi settings: reserve ${formatTokens(piSettings.reserveTokens)}, keep ${formatTokens(piSettings.keepRecentTokens)}` +
					`${piSettings.enabled ? "" : ", disabled"}`,
			];
			const warnings = settingsWarnings(policy, piSettings);
			notify(ctx, [...lines, ...warnings.map((warning) => `! ${warning}`)].join("\n"), warnings.length > 0 ? "warning" : "info");
		},
	});
}
