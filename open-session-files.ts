/**
 * pi-open-sessions-files-extension
 *
 * Lists all files edited/written by the agent in the current session,
 * then shows a fuzzy-search picker to select which one to open.
 *
 * Shortcuts:
 *   Alt+O (default, configurable) — Open file picker for session-edited files
 *
 * Commands:
 *   /open-file  — Same as Alt+F
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Key, Text, matchesKey, type SelectItem, SelectList } from "@mariozechner/pi-tui";
import fuzzysort from "fuzzysort";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";

function shellEscape(arg: string): string {
	return `'${arg.replace(/'/g, `"'"'`)}'`;
}

type OpenMode = "foreground" | "background";

type ExtensionSettings = {
	openCommand?: string;
	openMode?: OpenMode;
	shortcut?: string;
};

function pickExtensionSettings(parsed: any): ExtensionSettings {
	const direct = parsed?.openSessionFiles;
	return typeof direct === "object" && direct ? direct : {};
}

function normalizeMode(value: unknown): OpenMode | undefined {
	if (value === "foreground" || value === "background") return value;
	return undefined;
}

function loadSettings(cwd: string): ExtensionSettings {
	const envCommand = process.env.PI_OPEN_FILE_COMMAND?.trim();
	const envMode = normalizeMode(process.env.PI_OPEN_FILE_MODE?.trim());
	const envShortcut = process.env.PI_OPEN_FILE_SHORTCUT?.trim();

	let merged: ExtensionSettings = {};
	if (envCommand) merged.openCommand = envCommand;
	if (envMode) merged.openMode = envMode;
	if (envShortcut) merged.shortcut = envShortcut;

	// Respect PI_CODING_AGENT_DIR when provided (used by dev sandbox),
	// otherwise fall back to ~/.pi/agent.
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");

	// Main pi settings.json only (global, then project override)
	const settingsPaths = [join(agentDir, "settings.json"), join(cwd, ".pi", "settings.json")];
	for (const path of settingsPaths) {
		if (!existsSync(path)) continue;
		try {
			const raw = readFileSync(path, "utf-8");
			const parsed = JSON.parse(raw);
			merged = { ...merged, ...pickExtensionSettings(parsed) };
		} catch {
			// ignore invalid config, fallback to defaults
		}
	}

	merged.openMode = normalizeMode(merged.openMode) ?? "foreground";
	merged.shortcut = (merged.shortcut || "alt+o").toLowerCase();
	return merged;
}

function buildOpenCommand(filePath: string, cwd: string, settings: ExtensionSettings): string {
	const editor = process.env.VISUAL || process.env.EDITOR || "vi";
	const template = settings.openCommand?.trim() || `${editor} {file}`;
	const templateMentionsFile = template.includes("{file}");

	let command = template
		.replaceAll("{file}", shellEscape(filePath))
		.replaceAll("{cwd}", shellEscape(cwd));

	if (!templateMentionsFile) command += ` ${shellEscape(filePath)}`;
	return command;
}

function getSessionEditedFiles(ctx: any): string[] {
	const entries = ctx.sessionManager.getBranch() as any[];
	const seen = new Set<string>();
	const files: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg || msg.role !== "assistant") continue;
		if (!Array.isArray(msg.content)) continue;

		for (const block of msg.content) {
			if (!block || typeof block !== "object") continue;
			const t = block.type;
			if (t !== "toolCall" && t !== "tool_use" && t !== "tool_call") continue;

			const name: string = block.name ?? block.function?.name ?? "";
			if (name !== "edit" && name !== "write") continue;

			const args = block.arguments ?? block.input ?? (block.function?.arguments ? JSON.parse(block.function.arguments) : undefined);
			if (!args?.path) continue;

			const filePath = String(args.path).replace(/^@/, "");
			if (!seen.has(filePath)) {
				seen.add(filePath);
				files.push(filePath);
			}
		}
	}

	return files;
}

function runOpenCommand(filePath: string, cwd: string, settings: ExtensionSettings): void {
	const shell = process.env.SHELL || "/bin/sh";
	const command = buildOpenCommand(filePath, cwd, settings);
	const mode = settings.openMode ?? "foreground";

	if (mode === "background") {
		const child = spawn(shell, ["-lc", command], {
			stdio: "ignore",
			env: process.env,
			cwd,
			detached: true,
		});
		child.unref();
		return;
	}

	spawnSync(shell, ["-lc", command], {
		stdio: "inherit",
		env: process.env,
		cwd,
	});
}

type Candidate = {
	path: string;
	search: string;
};

function rankCandidates(candidates: Candidate[], query: string): Candidate[] {
	if (!query.trim()) return candidates;
	const results = fuzzysort.go(query, candidates, { key: "search", limit: 200 });
	return results.map((r) => r.obj);
}

function toSelectItems(candidates: Candidate[]): SelectItem[] {
	return candidates.map((c) => ({
		value: c.path,
		label: c.path,
	}));
}

export default function (pi: ExtensionAPI) {
	const startupSettings = loadSettings(process.cwd());
	const shortcut = startupSettings.shortcut || "alt+o";

	const openFilePicker = async (ctx: any) => {
		const files = getSessionEditedFiles(ctx);
		if (files.length === 0) {
			ctx.ui.notify("No files edited by the agent in this session", "warning");
			return;
		}

		const settings = loadSettings(ctx.cwd);
		const candidates: Candidate[] = files
			.filter((path) => existsSync(path))
			.map((path) => {
				const base = basename(path);
				return { path, search: `${base} ${path}` };
			});

		if (candidates.length === 0) {
			ctx.ui.notify("No existing edited files to open", "warning");
			return;
		}

		const selected = await ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: any) => {
			let filter = "";
			const top = new DynamicBorder((s: string) => theme.fg("accent", s));
			const title = new Text(theme.fg("accent", theme.bold(" pi-open-sessions-files-extension")), 0, 0);
			const filterLine = new Text("", 0, 0);
			const help = new Text(theme.fg("dim", " ↑↓ navigate • type fuzzy filter • backspace delete • enter open • esc cancel"), 0, 0);
			const bottom = new DynamicBorder((s: string) => theme.fg("accent", s));

			const selectTheme = {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			};

			const buildList = () => {
				const ranked = rankCandidates(candidates, filter);
				const items = toSelectItems(ranked);
				const list = new SelectList(items, Math.min(items.length || 1, 12), selectTheme);
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(null);
				return list;
			};

			const updateFilterLine = () => filterLine.setText(theme.fg("dim", ` filter: ${filter || "(empty)"}`));
			let list = buildList();
			updateFilterLine();

			return {
				render: (w: number) => [...top.render(w), ...title.render(w), ...filterLine.render(w), ...list.render(w), ...help.render(w), ...bottom.render(w)],
				invalidate: () => {
					top.invalidate();
					title.invalidate();
					filterLine.invalidate();
					list.invalidate();
					help.invalidate();
					bottom.invalidate();
				},
				handleInput: (data: string) => {
					if (matchesKey(data, Key.backspace)) {
						filter = filter.slice(0, -1);
						updateFilterLine();
						list = buildList();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.ctrl("u"))) {
						filter = "";
						updateFilterLine();
						list = buildList();
						tui.requestRender();
						return;
					}
					if (data.length === 1 && data >= " " && data !== "\x7f") {
						filter += data;
						updateFilterLine();
						list = buildList();
						tui.requestRender();
						return;
					}
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!selected) return;
		if (!existsSync(selected)) {
			ctx.ui.notify(`File no longer exists: ${selected}`, "warning");
			return;
		}

		if ((settings.openMode ?? "foreground") === "background") {
			runOpenCommand(selected, ctx.cwd, settings);
			ctx.ui.notify("Launched open command in background", "info");
			return;
		}

		await ctx.ui.custom<void>((tui: any, _theme: any, _kb: any, done: any) => {
			tui.stop();
			process.stdout.write("\x1b[2J\x1b[H");
			runOpenCommand(selected, ctx.cwd, settings);
			tui.start();
			tui.requestRender(true);
			done();
			return { render: () => [], invalidate: () => {} };
		});
	};

	pi.registerShortcut(shortcut, {
		description: "Pick and open a file edited by the agent this session",
		handler: openFilePicker,
	});

	pi.registerCommand("open-file", {
		description: "Pick and open a file edited by the agent this session",
		handler: async (_args, ctx) => openFilePicker(ctx),
	});
}
