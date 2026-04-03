'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

// ─── Database Stubs ───────────────────────────────────────────────────────────
// TODO: Replace both functions with actual calls to modules/Database.js

/**
 * Search for stored procedures by name fragment.
 * @param {string} query
 * @returns {Promise<string[]>}
 */
async function searchProcedures(query) {
	const dummy = [
		'uspGetUserById', 'uspUpdateUserEmail', 'uspCreateOrder',
		'uspGetOrderHistory', 'uspDeleteExpiredSessions',
		'uspProcessPayment', 'uspSendNotification',
	];
	const q = (query || '').toLowerCase();
	return dummy.filter(n => n.toLowerCase().includes(q));
}

/**
 * Fetch a stored procedure body from the database.
 * Return value must start with ALTER PROCEDURE [dbo].[name].
 * Do NOT include SET ANSI_NULLS / GO / author header — the extension adds those.
 * @param {string} name
 * @returns {Promise<string>}
 */
async function fetchProcedure(name) {
	return [
		`ALTER PROCEDURE [dbo].[${name}]`,
		`AS`,
		`BEGIN`,
		`    SET NOCOUNT ON;`,
		`    -- TODO: replace with actual fetch from modules/Database.js`,
		`    SELECT 1 AS Result`,
		`END`,
	].join('\n');
}

function makeNewProcedure(name) {
	// Rollback side: IF EXISTS / DROP stub.
	const rollbackBlock = [
		`IF EXISTS(SELECT * FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_NAME = '${name}') BEGIN`,
		`\tDROP PROCEDURE [dbo].[${name}]`,
		`END`,
		`GO`,
	].join('\n');

	// Update side: CREATE PROCEDURE template.
	const createBlock = [
		`CREATE PROCEDURE [dbo].[${name}]`,
		`AS`,
		`BEGIN`,
		`    SET NOCOUNT ON;`,
		`    -- TODO: Implement procedure`,
		`END`,
	].join('\n');

	return {
		rollbackBlock,
		createBlock
	}
}

// ─── Parser / Serialiser ──────────────────────────────────────────────────────

const DELIM_CHANGE_HEADER = '----  #Chiasm Change# ----';
const DELIM_CHANGE_START = '----  #Change Start#  ----';
const DELIM_CHANGE_END = '----  #Change End#    ----';
const CHIASM_CONSTRUCTION_RE = /^-{3,}[^\n]*\n[^\n]*\bConstruction\b[^\n]*\n-{3,}[^\n]*/m;
const PROC_NAME_RE = /^(?:CREATE|ALTER|DROP)\s+PROCEDURE\s+(?:\[?dbo\]?\.)?\[?(\w+)\]?/im;
const IF_EXISTS_RE = /ROUTINE_NAME\s*=\s*'(\w+)'/i;

/** Resolved defaults for all known options. */
const DEFAULT_OPTIONS = Object.freeze({ showDiff: true, editable: false });

// ─── ChangeBlock ──────────────────────────────────────────────────────────────

/**
 * Represents one half of a change pair — either an update or a rollback block.
 * Handles delimiter parsing and serialisation, and stores per-block options.
 */
class ChangeBlock {
	#type;
	#options;
	#rawText;

	/**
	 * @param {'update'|'rollback'} type
	 * @param {Record<string,boolean>} options  Only options explicitly set in the delimiter.
	 * @param {string} rawText                  SQL text between #Change Start# and #Change End#.
	 */
	constructor(type, options, rawText) {
		this.#type = type;
		this.#options = { ...options };
		this.#rawText = rawText;
	}

	/**
	 * Parse a full block string (delimiters included) into a ChangeBlock instance.
	 * The string must contain #Chiasm Change#, #Change Start#, and #Change End#.
	 * @param {string} str
	 * @param {'update'|'rollback'} type
	 * @returns {ChangeBlock}
	 */
	static fromString(str, type) {
		const hIdx = str.indexOf(DELIM_CHANGE_HEADER);
		const sIdx = str.indexOf(DELIM_CHANGE_START);
		const eIdx = str.indexOf(DELIM_CHANGE_END);
		if (hIdx === -1 || sIdx === -1 || eIdx === -1 || eIdx < sIdx)
			throw new Error('ChangeBlock.fromString: malformed block string');

		// Parse options from between the header and the #Change Start# line.
		const optSection = str.slice(hIdx + DELIM_CHANGE_HEADER.length, sIdx);
		const options = {};
		for (const line of optSection.split('\n')) {
			const m = line.match(/^----\s+([\w]+):\s*(true|false)\s*$/);
			if (m) options[m[1]] = m[2] === 'true';
		}

		const rawText = str.slice(sIdx + DELIM_CHANGE_START.length, eIdx).trim();
		return new ChangeBlock(type, options, rawText);
	}

	/**
	 * Serialise this block back to its full delimited form.
	 * @returns {string}
	 */
	toString() {
		const lines = [DELIM_CHANGE_HEADER];
		for (const [k, v] of Object.entries(this.#options))
			lines.push(`----  ${k}: ${v}`);
		lines.push(DELIM_CHANGE_START, this.#rawText, DELIM_CHANGE_END);
		return lines.join('\n');
	}

	get type() { return this.#type; }
	get rawText() { return this.#rawText; }
	set rawText(v) { this.#rawText = String(v); }

	/** Shallow copy of options stored in this block only (no defaults applied). */
	get options() { return { ...this.#options }; }

	/**
	 * Returns the value of an option set explicitly on this block, or undefined if absent.
	 * @param {string} key
	 */
	getOwnOption(key) { return this.#options[key]; }

	setOption(key, value) { this.#options[key] = value; }
}

// ─── ChangePair ───────────────────────────────────────────────────────────────

/**
 * A matched pair of update and rollback blocks for a single stored procedure.
 * The procedure name is automatically extracted from the SQL content.
 */
class ChangePair {
	#name;
	#updateBlock;
	#rollbackBlock;

	/**
	 * @param {string} name
	 * @param {ChangeBlock} updateBlock
	 * @param {ChangeBlock} rollbackBlock
	 */
	constructor(name, updateBlock, rollbackBlock) {
		this.#name = name;
		this.#updateBlock = updateBlock;
		this.#rollbackBlock = rollbackBlock;
	}

	static #extractName(text) {
		const m = text.match(PROC_NAME_RE);
		if (m) return m[1];
		const ifm = text.match(IF_EXISTS_RE);
		return ifm ? ifm[1] : null;
	}

	/**
	 * Create a ChangePair by auto-detecting the procedure name from block SQL.
	 * @param {ChangeBlock} updateBlock
	 * @param {ChangeBlock} rollbackBlock
	 * @returns {ChangePair}
	 */
	static fromBlocks(updateBlock, rollbackBlock) {
		const name = ChangePair.#extractName(updateBlock.rawText)
			|| ChangePair.#extractName(rollbackBlock.rawText)
			|| 'Unknown';
		return new ChangePair(name, updateBlock, rollbackBlock);
	}

	get name() { return this.#name; }
	set name(v) { this.#name = String(v); }
	get updateBlock() { return this.#updateBlock; }
	get rollbackBlock() { return this.#rollbackBlock; }

	setUpdateText(text) { this.#updateBlock.rawText = text; }
	setRollbackText(text) { this.#rollbackBlock.rawText = text; }
	getUpdateText() { return this.#updateBlock.rawText; }
	getRollbackText() { return this.#rollbackBlock.rawText; }

	/**
	 * Resolve an option value.
	 * Priority: rollback block options → update block options → global defaults.
	 * @param {string} option
	 */
	getOption(option) {
		const rbVal = this.#rollbackBlock.getOwnOption(option);
		if (rbVal !== undefined) return rbVal;
		const upVal = this.#updateBlock.getOwnOption(option);
		if (upVal !== undefined) return upVal;
		return DEFAULT_OPTIONS[option] ?? null;
	}

	/**
	 * True when the rollback block is a DROP stub rather than a full procedure —
	 * i.e., this procedure does not yet exist in the database.
	 */
	get isNew() { return !PROC_NAME_RE.test(this.#rollbackBlock.rawText); }
}

// ─── ChangeScript ─────────────────────────────────────────────────────────────

/**
 * Top-level container for all change pairs in a .sql change-script document.
 * Handles full document parse and serialisation.
 */
class ChangeScript {
	#pairs;

	/** @param {ChangePair[]} pairs */
	constructor(pairs) { this.#pairs = [...pairs]; }

	/**
	 * Parse an entire document string into a ChangeScript.
	 * Returns null when the document has content but is structurally invalid
	 * (no Chiasm Construction line, or mismatched update/rollback block counts).
	 * An empty document returns an empty ChangeScript (not null).
	 * @param {string} str
	 * @returns {ChangeScript|null}
	 */
	static fromString(str) {
		if (!str.trim()) return new ChangeScript([]);

		const cm = CHIASM_CONSTRUCTION_RE.exec(str);
		if (!cm) return null;   // no construction line → invalid

		const rollbackSection = str.slice(0, cm.index);
		const updateSection = str.slice(cm.index + cm[0].length);

		const rollbackBlocks = ChangeScript.#parseSection(rollbackSection, 'rollback');
		const updateBlocks = ChangeScript.#parseSection(updateSection, 'update');

		if (rollbackBlocks.length !== updateBlocks.length) return null;  // mismatched → invalid

		// Rollbacks are stored in reverse order above the construction line.
		const pairs = updateBlocks.map((upBlock, i) => {
			const rbBlock = rollbackBlocks[rollbackBlocks.length - 1 - i];
			return ChangePair.fromBlocks(upBlock, rbBlock);
		});

		if (!pairs || (pairs.length < 1 && str.toUpperCase().includes('PROCEDURE'))) {
			// Change script includes "PROCEDURE" but no pairs were found.
			// Sounds invalid to me...
			return null;
		}

		return new ChangeScript(pairs);
	}

	/**
	 * Build a ChangeScript from an array of plain procedure records.
	 * Used when re-serialising after in-memory edits by the extension host.
	 * Each record may carry updateOptions / rollbackOptions to preserve
	 * options that were set in the original file.
	 * @param {{ name: string, original: string, edited: string,
	 *            updateOptions?: {}, rollbackOptions?: {} }[]} records
	 * @returns {ChangeScript}
	 */
	static fromRecords(records) {
		const pairs = records.map(r => {
			const upBlock = new ChangeBlock('update', r.updateOptions || {}, r.edited);
			const rbBlock = new ChangeBlock('rollback', r.rollbackOptions || {}, r.original);
			return new ChangePair(r.name, upBlock, rbBlock);
		});
		return new ChangeScript(pairs);
	}

	/** @returns {ChangePair[]} */
	get pairs() { return [...this.#pairs]; }
	get length() { return this.#pairs.length; }

	/** Parse one section of the document into an ordered array of ChangeBlocks. */
	static #parseSection(sectionText, type) {
		const blocks = [];
		let pos = 0;
		while (true) {
			const start = sectionText.indexOf(DELIM_CHANGE_HEADER, pos);
			if (start === -1) break;
			const end = sectionText.indexOf(DELIM_CHANGE_END, start);
			if (end === -1) break;
			const blockStr = sectionText.slice(start, end + DELIM_CHANGE_END.length);
			try { blocks.push(ChangeBlock.fromString(blockStr, type)); } catch (_) { /* skip malformed */ }
			pos = end + DELIM_CHANGE_END.length;
		}
		return blocks;
	}

	/**
	 * Serialise the full document back to a string.
	 * Rollbacks appear in reverse order above the Chiasm Construction line;
	 * updates appear in their natural order below it.
	 * @returns {string}
	 */
	toString() {
		if (!this.#pairs.length) return '';
		const chiasm = '--------------------------------\n----  Chiasm Construction   ----\n--------------------------------';
		const rollbackStr = [...this.#pairs].reverse()
			.map(p => p.rollbackBlock.toString()).join('\n\n');
		const updateStr = this.#pairs
			.map(p => p.updateBlock.toString()).join('\n\n');
		return `${rollbackStr}\n\n${chiasm}\n\n${updateStr}\n`;
	}

	/**
	 * Convert to plain procedure records for consumption by the webview.
	 * Each record carries updateOptions and rollbackOptions so they survive
	 * round-trips through the in-memory procedures array without data loss.
	 */
	toProcedureRecords() {
		return this.#pairs.map(p => ({
			name: p.name,
			original: p.getRollbackText(),
			edited: p.getUpdateText(),
			isNew: p.isNew,
			showDiff: p.getOption('showDiff'),
			editable: p.getOption('editable'),
			updateOptions: p.updateBlock.options,
			rollbackOptions: p.rollbackBlock.options,
		}));
	}
}

/** Serialise a plain procedures array to the full document string. */
function serializeDocument(procedures) {
	return ChangeScript.fromRecords(procedures).toString();
}

// ─── Plain-text fallback HTML (used for git:// diff views) ───────────────────

function getPlainTextHtml(text) {
	const escaped = text
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  html, body { margin: 0; padding: 0; height: 100%;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground); }
  pre { padding: 12px; margin: 0;
    font-family: var(--vscode-editor-font-family, 'Courier New', monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    line-height: 1.5; white-space: pre; overflow: auto; height: 100%;
    box-sizing: border-box; }
</style>
</head>
<body><pre>${escaped}</pre></body>
</html>`;
}

// ─── Main Webview HTML ────────────────────────────────────────────────────────

function getWebviewHtml(context) {
	const htmlPath = path.join(context.extensionPath, 'web', 'index.html');
	const rawHtml = fs.readFileSync(htmlPath, 'utf8');

	const scriptSrcRegex = /<\s*(script)\s+src\s*=\s*"\.\/(.*?)"\s*><\s*\/\s*script\s*>/gmi;
	const cssSrcRegex = /<\s*link\s+rel\s*=\s*"(stylesheet)"\s+href\s*=\s*"\.\/(.*?)"\s*\/?\s*>/gmi;

	const handleMatches = (match, type, relLink) => {
		const tag = type.toLowerCase()==='script' ? 'script' : 'style';
		const filePath = path.join(context.extensionPath, 'web', relLink);
		if (!fs.existsSync) {
			console.warn(`filePath '${relLink}' not found`);
		}
		return `<${tag}>\n${fs.readFileSync(filePath, 'utf8')}\n</${tag}>`;
	}

	// replace css and script tags with actual code
	return rawHtml
		.replace(scriptSrcRegex, handleMatches)
		.replace(cssSrcRegex, handleMatches);
}

// ─── Read-only Document Provider ─────────────────────────────────────────────

class ReadonlyContentProvider {
	constructor() {
		this._onDidChange = new vscode.EventEmitter();
		this.onDidChange = this._onDidChange.event;
		this._map = new Map();
	}
	setContent(uri, text) {
		this._map.set(uri.toString(), text);
		this._onDidChange.fire(uri);
	}
	provideTextDocumentContent(uri) {
		return this._map.get(uri.toString()) ?? '';
	}
}

// ─── Custom Editor Provider ───────────────────────────────────────────────────

class SqlChangeScriptEditorProvider {

	constructor(context, roProvider) {
		this._context = context;
		this._roProvider = roProvider;
	}

	static register(context, roProvider) {
		return vscode.window.registerCustomEditorProvider(
			'sqlChangeScript.editor',
			new SqlChangeScriptEditorProvider(context, roProvider),
			{
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: false,
			}
		);
	}

	async resolveCustomTextEditor(document, panel, _token) {
		// ── Git diff / non-file scheme fallback ───────────────────────────────────
		// When VS Code opens a .sql file for a git diff, the "before" version uses
		// scheme 'git'. We show plain text there so VS Code can render its own diff.
		if (document.uri.scheme !== 'file') {
			await vscode.commands.executeCommand('workbench.action.reopenWithEditor');
			panel.webview.options = { enableScripts: false };
			panel.webview.html = getPlainTextHtml(document.getText());
			return;
		}

		// Parse the document; null means structurally invalid (no construction line
		// or mismatched block counts) — fall back to the standard text editor.
		const parsed = ChangeScript.fromString(document.getText());
		if (parsed === null) {
			panel.webview.options = { enableScripts: false };
			panel.webview.html = getPlainTextHtml(document.getText());
			vscode.window.showWarningMessage(
				'SQL Change Script Editor: Document structure is invalid (missing Chiasm Construction line or mismatched change blocks). Opening in text editor.'
			);
			setTimeout(() => panel.dispose(), 1);
			await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
			return;
		}

		// ── Full custom editor ────────────────────────────────────────────────────
		const context = this._context;   // captured for use in async callbacks

		panel.webview.options = { enableScripts: true };
		panel.webview.html = getWebviewHtml(context, panel, document);

		let procedures = parsed.toProcedureRecords();
		let suppressCnt = 0;
		let switchToLastIndex = false;

		const postInit = () => {
			panel.webview.postMessage({
				type: 'init',
				procedures,
				switchToIdx: (switchToLastIndex) ? procedures.length - 1 : undefined,
				rollbackVisible: context.globalState.get('rollbackVisible', true),
			});
			switchToLastIndex = false;
		}

		/**
		 * Apply a new procedures array to the document (for structural changes only —
		 * add, create, refresh, reorder). Debounced in-progress edits are already
		 * in memory; the onWillSaveTextDocument handler flushes them on Ctrl+S.
		 */
		const applyEdit = async (newProcs) => {
			procedures = newProcs;
			const newText = serializeDocument(procedures);
			if (newText === document.getText()) return;
			const edit = new vscode.WorkspaceEdit();
			edit.replace(
				document.uri,
				new vscode.Range(
					new vscode.Position(0, 0),
					document.positionAt(document.getText().length)
				),
				newText
			);
			suppressCnt++;
			const ok = await vscode.workspace.applyEdit(edit);
			suppressCnt--;
			if (!ok) vscode.window.showErrorMessage('Becker Change Scripter: failed to update document.');
		};

		// Detect external edits (e.g. user edits raw SQL in a plain-text tab).
		const refreshFromDocument = (e=null) => {
			if (suppressCnt > 0) return;
			if (e && e.document.uri.toString() !== document.uri.toString()) return;
			const reparsed = ChangeScript.fromString(document.getText());
			if (reparsed === null) return;  // invalid edit — ignore, don't clobber in-memory state
			procedures = reparsed.toProcedureRecords();
			postInit();
		}
		const docSub = vscode.workspace.onDidChangeTextDocument(refreshFromDocument);

		// Flush debounced edits before the file is written to disk.
		// This is the only path that writes edited procedure content to the file.
		const saveSub = vscode.workspace.onWillSaveTextDocument(e => {
			if (e.document.uri.toString() !== document.uri.toString()) return;
			const newText = serializeDocument(procedures);
			if (newText === document.getText()) return;
			e.waitUntil(Promise.resolve([
				new vscode.TextEdit(
					new vscode.Range(
						new vscode.Position(0, 0),
						document.positionAt(document.getText().length)
					),
					newText
				)
			]));
		});

		panel.onDidDispose(() => { docSub.dispose(); saveSub.dispose(); });

		// ── Webview message handler ───────────────────────────────────────────────
		panel.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.type) {

				case 'saveDiffState': {
					context.globalState.update('rollbackVisible', msg.rollbackVisible);
					break;
				}

				case 'ready':
					postInit();
					break;

				// User typed in the editor — update in-memory state only.
				// The document will be written on Ctrl+S via onWillSaveTextDocument.
				// NOT calling applyEdit here is what preserves cursor position and undo history.
				case 'edit': {
					const p = procedures.find(x => x.name === msg.name);
					if (!p) break;
					p.edited = msg.body;
					break;
				}

				// User edited the original/rollback side (only when editable:true is set).
				case 'editOriginal': {
					const p = procedures.find(x => x.name === msg.name);
					if (!p) break;
					p.original = msg.body;
					break;
				}

				// User toggled showDiff or editable for a proc — persist to file.
				case 'setOption': {
					const p = procedures.find(x => x.name === msg.name);
					if (!p) break;
					p.rollbackOptions = Object.assign({}, p.rollbackOptions || {}, { [msg.option]: msg.value });
					p[msg.option] = msg.value;
					await applyEdit(procedures);
					break;
				}

				case 'searchProcedures': {
					const results = await searchProcedures(msg.query);
					panel.webview.postMessage({ type: 'searchResults', results });
					break;
				}

				case 'fetchProcedure': {
					if (procedures.some(p => p.name === msg.name)) break;
					const rawBody = await fetchProcedure(msg.name);
					await applyEdit([...procedures, {
						name: msg.name, original: rawBody, edited: rawBody, isNew: false,
						updateOptions: {}, rollbackOptions: {},
					}]);
					switchToLastIndex = true;
					refreshFromDocument();
					break;
				}

				// Create a brand-new stored procedure (not yet in the database).
				case 'createProcedure': {
					const name = msg.name;
					if (procedures.some(p => p.name === name)) break;

					const { rollbackBlock, createBlock } = makeNewProcedure(name);

					await applyEdit([...procedures, {
						name, original: rollbackBlock, edited: createBlock, isNew: true,
						// New procs have no meaningful diff — store showDiff:false on the update block.
						updateOptions: {}, rollbackOptions: { showDiff: false },
					}]);
					switchToLastIndex = true;
					refreshFromDocument();
					break;
				}

				case 'refreshProcedure': {
					const choice = await vscode.window.showWarningMessage(
						`Re-fetch "${msg.name}" from the database?\n\n`
						+ `This will overwrite the saved snapshot. Make sure the database currently `
						+ `holds the version you want to roll back to.`,
						{ modal: true },
						'Re-fetch'
					);
					if (choice !== 'Re-fetch') break;
					const rawBody = await fetchProcedure(msg.name);
					await applyEdit(procedures.map(p =>
						p.name === msg.name
							? {
								name: msg.name, original: rawBody, edited: p.edited, isNew: false,
								updateOptions: {}, rollbackOptions: {}
							}
							: p
					));
					postInit();
					break;
				}

				// Drag-to-reorder: move a procedure from one index to another.
				case 'reorder': {
					const { fromIdx, toIdx } = msg;
					if (fromIdx < 0 || fromIdx >= procedures.length) break;
					if (toIdx < 0 || toIdx >= procedures.length) break;
					if (fromIdx === toIdx) break;
					const newProcs = [...procedures];
					const [moved] = newProcs.splice(fromIdx, 1);
					newProcs.splice(toIdx, 0, moved);
					await applyEdit(newProcs);
					postInit();
					break;
				}

				// Remove a procedure from the change script (with confirmation).
				case 'removeProc': {
					const choice = await vscode.window.showWarningMessage(
						`Remove "${msg.name}" from this change script?\n\nThis cannot be undone.`,
						{ modal: true },
						'Remove'
					);
					if (choice !== 'Remove') break;
					await applyEdit(procedures.filter(p => p.name !== msg.name));
					postInit();
					break;
				}

				// Rename a new (not-yet-in-DB) procedure, updating both sides.
				case 'renameProcedure': {
					const oldName = msg.name;
					const p = procedures.find(x => x.name === oldName);
					if (!p || !p.isNew) break;
					const newName = await vscode.window.showInputBox({
						title: 'Rename Stored Procedure',
						prompt: `Rename "${oldName}" to:`,
						value: oldName,
						validateInput: v => {
							v = (v || '').trim();
							if (!v) return 'Name cannot be empty.';
							if (v !== oldName && procedures.some(x => x.name === v))
								return `"${v}" already exists in this change script.`;
							return null;
						},
					});
					if (!newName || newName.trim() === oldName) break;
					const n = newName.trim();
					const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
					// Update the IF EXISTS rollback stub.
					const newOriginal = p.original
						.replace(new RegExp(`ROUTINE_NAME\\s*=\\s*'${esc(oldName)}'`, 'i'),
							`ROUTINE_NAME = '${n}'`)
						.replace(new RegExp(`\\[${esc(oldName)}\\]`, 'g'), `[${n}]`);
					// Update the CREATE PROCEDURE body.
					const newEdited = p.edited
						.replace(new RegExp(`\\[${esc(oldName)}\\]`, 'g'), `[${n}]`);
					await applyEdit(procedures.map(x =>
						x.name === oldName
							? {
								name: n, original: newOriginal, edited: newEdited, isNew: true,
								updateOptions: x.updateOptions || {}, rollbackOptions: x.rollbackOptions || {}
							}
							: x
					));
					postInit();
					break;
				}

				case 'viewChangeScript': {
					// Re-open the same file with VS Code's built-in text editor so the
					// user sees the raw, fully editable SQL without the custom editor.
					await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
					break;
				}
			}
		});
	}
}

// ─── Activate ─────────────────────────────────────────────────────────────────

function activate(context) {
	const roProvider = new ReadonlyContentProvider();
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(
			'sqlchangescript-readonly',
			roProvider
		),
		SqlChangeScriptEditorProvider.register(context, roProvider)
	);
}

module.exports = { activate };