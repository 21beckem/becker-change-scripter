const SPLOTCH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path d="M272.5 126.3L300.6 89.4C312.8 73.4 331.8 64 352 64C380.5 64 405.6 82.7 413.8 110L431.6 169.4C441.9 203.8 467.7 231.4 501.4 244L541.2 258.9C562.1 266.8 576 286.8 576 309.1C576 326 568.1 341.9 554.5 352L487.2 402.5C462.9 420.7 450 450.4 453.4 480.6L455.9 503.3C460.2 542 429.9 575.9 390.9 575.9C376.1 575.9 361.6 570.8 350 561.6L294.7 517.3C290.2 513.7 285.4 510.6 280.2 508.1C264.4 500.2 246.5 497.7 229.2 500.8L146.4 515.9C111.8 522.2 80 495.6 80 460.5C80 447.3 84.7 434.5 93.1 424.3L104.3 410.9C118.9 393.5 126.9 371.5 126.9 348.8C126.9 330 121.4 311.6 111.1 295.8L72.8 237.5C67.1 228.7 64 218.4 64 207.9C64 174.5 94.1 149.1 127 154.7L178.3 163.4C214.2 169.5 250.5 155.2 272.5 126.3z"/></svg>`;
(function () {
	'use strict';

	require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });

	require(['vs/editor/editor.main'], function (monaco) {

		var vscode = acquireVsCodeApi();

		const showWarningMessage = (message, btnText) => {
			return new Promise(resolve => {
				const uid = crypto.randomUUID();
				const listener = (event) => {
					const msg = event.data;
					debugger;
					if (msg.type !== 'showWarningMessageResponse' || msg.uid !== uid) return;
					window.removeEventListener('message', listener);
					resolve(msg.response);
				}
				window.addEventListener('message', listener);
				
				vscode.postMessage({ type: 'showWarningMessage', message, btnText, uid });
			});
		}

		// ── Global display state ───────────────────────────────────────────────
		var rollbackVisible = true; // seeded from globalState via first 'init'

		// ── Runtime state ──────────────────────────────────────────────────────
		var procedures       = [];
		var currentIdx       = -1;
		var suppressModelChg = false;
		var dragSrcIdx       = -1;

		// ── DOM refs ───────────────────────────────────────────────────────────
		function $(id) { return document.getElementById(id); }

		var miniMap              = $('mini-map'),
			editorPanels         = $('editor-panels'),
			noSel                = $('no-selection'),
			generativePanel      = $('generative-panel'),
			generativeResizer    = $('generative-resizer'),
			generativeEditorEl   = $('generative-editor'),
			generativeError      = $('generative-error-overlay'),
			generativeErrorMsg   = $('generative-error-message'),
			editorHeader         = $('editor-header'),
			monacoWrapper        = $('monaco-wrapper'),
			diffContainer        = $('diff-container'),
			plainContainer       = $('plain-container'),
			splitContainer       = $('split-container'),
			splitLeft            = $('split-left'),
			splitRight           = $('split-right'),
			procTitle            = $('proc-title'),
			toggleBtn            = $('toggle-diff'),
			btnGenerateRollback  = $('btn-generate-rollback'),
			btnShowDiff          = $('btn-toggle-show-diff'),
			btnEditable          = $('btn-toggle-editable'),
			validationBanner     = $('validation-banner'),
			ctxMenuEl            = $('context-menu'),
			addDropdown          = $('add-dropdown'),
			searchOverlay        = $('search-overlay'),
			searchView           = $('search-view'),
			createView           = $('create-view'),
			procSearchInput      = $('proc-search-input'),
			procSearchResults    = $('proc-search-results'),
			createInput          = $('create-input'),
			createError          = $('create-error'),
			columnOverlay        = $('column-overlay'),
			tableSearchInput     = $('table-search-input'),
			tableSearchResults   = $('table-search-results'),
			colTable             = $('col-table'),
			colName              = $('col-name'),
			colType              = $('col-type'),
			colDefault           = $('col-default'),
			columnError          = $('column-error');

		// ── Monaco theme ────────────────────────────────────────────────────────
		var isDark = document.body.classList.contains('vscode-dark')
			|| document.body.classList.contains('vscode-high-contrast');
		var monacoTheme = isDark ? 'vs-dark' : 'vs';

		// ── Shared text models ──────────────────────────────────────────────────
		var originalModel = monaco.editor.createModel('', 'sql');
		var modifiedModel = monaco.editor.createModel('', 'sql');
		var generativeJsModel = monaco.editor.createModel('', 'javascript');

		// ── Common editor option defaults ───────────────────────────────────────
		var commonOpts = {
			automaticLayout:      true,
			theme:                monacoTheme,
			fontSize:             13,
			scrollBeyondLastLine: true,
			minimap:              { enabled: false },
			lineNumbers:          'on',
			wordWrap:             'off',
			renderWhitespace:     'selection',
		};

		// ── Diff editor  (rollbackVisible=true, showDiff=true) ──────────────────
		var diffEditor = monaco.editor.createDiffEditor(diffContainer, Object.assign({}, commonOpts, {
			renderSideBySide:        true,
			enableSplitViewResizing: true,
			originalEditable:        false,
			readOnly:                false,
		}));
		diffEditor.setModel({ original: originalModel, modified: modifiedModel });

		// ── Plain editor  (rollbackVisible=false) ───────────────────────────────
		var plainEditor = monaco.editor.create(plainContainer, Object.assign({}, commonOpts, {
			model:    modifiedModel,
			language: 'sql',
		}));

		// ── Split editors  (rollbackVisible=true, showDiff=false) ───────────────
		var splitLeftEditor = monaco.editor.create(splitLeft, Object.assign({}, commonOpts, {
			model:    modifiedModel,
			language: 'sql',
		}));
		var splitRightEditor = monaco.editor.create(splitRight, Object.assign({}, commonOpts, {
			model:    originalModel,
			language: 'sql',
			readOnly: true,
		}));

		// ── Generative JavaScript editor ────────────────────────────────────────
		var generativeEditor = monaco.editor.create(generativeEditorEl, Object.assign({}, commonOpts, {
			model: generativeJsModel,
			language: 'javascript',
			wordWrap: 'on',
		}));

		// ── Display mode ────────────────────────────────────────────────────────
		function getCurrentMode() {
			if (!rollbackVisible || currentIdx < 0) return 'plain';
			return procedures[currentIdx].showDiff !== false ? 'diff' : 'split';
		}

		function normalizeEditorState(editor, model) {
			var pos = editor.getPosition();
			var safePos = model.validatePosition(pos || { lineNumber: 1, column: 1 });
			if (!pos || pos.lineNumber !== safePos.lineNumber || pos.column !== safePos.column) {
				editor.setPosition(safePos);
			}

			var sel = editor.getSelection();
			if (!sel) return;
			var safeSel = model.validateRange(sel);
			if (!sel.equalsRange(safeSel)) {
				editor.setSelection(safeSel);
			}
		}

		function normalizeAllEditorStates() {
			normalizeEditorState(diffEditor.getOriginalEditor(), originalModel);
			normalizeEditorState(diffEditor.getModifiedEditor(), modifiedModel);
			normalizeEditorState(plainEditor, modifiedModel);
			normalizeEditorState(splitLeftEditor, modifiedModel);
			normalizeEditorState(splitRightEditor, originalModel);
		}

		function applyMode(triggerLayout) {
			var mode = getCurrentMode();
			diffContainer.style.display  = mode === 'diff'  ? 'block' : 'none';
			plainContainer.style.display = mode === 'plain' ? 'block' : 'none';
			splitContainer.style.display = mode === 'split' ? 'flex'  : 'none';
			toggleBtn.innerHTML = rollbackVisible ? '&#x25C0; Hide Rollback' : '&#x25B6; Show Rollback';
			if (mode === 'diff') {
				// Rebind on every diff-show transition to avoid stale Monaco state.
				diffEditor.setModel({ original: originalModel, modified: modifiedModel });
			}
			normalizeAllEditorStates();
			if (triggerLayout) {
				setTimeout(function () {
					if (mode === 'diff')  { diffEditor.layout(); }
					if (mode === 'plain') { plainEditor.layout(); }
					if (mode === 'split') { splitLeftEditor.layout(); splitRightEditor.layout(); }
				}, 0);
			}
		}

		// ── Per-proc option helpers ─────────────────────────────────────────────

		function isGenerativeProc(proc) {
			return !!proc && proc.changeType === 'generative';
		}

		function setGeneratedSqlReadOnly(proc) {
			var readOnly = isGenerativeProc(proc);
			diffEditor.getModifiedEditor().updateOptions({ readOnly: readOnly });
			plainEditor.updateOptions({ readOnly: readOnly });
			splitLeftEditor.updateOptions({ readOnly: readOnly });
		}

		function applyEditableState(proc) {
			if (isGenerativeProc(proc)) {
				diffEditor.getOriginalEditor().updateOptions({ readOnly: true });
				splitRightEditor.updateOptions({ readOnly: true });
				return;
			}
			var editable = proc.editable === true;
			diffEditor.getOriginalEditor().updateOptions({ readOnly: !editable });
			splitRightEditor.updateOptions({ readOnly: !editable });
		}

		function setGenerativeErrorOverlay(proc) {
			var show = isGenerativeProc(proc) && proc.generativeSuccess === false;
			generativeError.style.display = show ? 'flex' : 'none';
			if (!show) return;
			generativeErrorMsg.textContent = proc.generativeMessage
				? 'JavaScript generation failed: ' + proc.generativeMessage
				: 'JavaScript generation failed. Save again after fixing the script.';
		}

		var dragState = null;
		function getGenerativeSplitSpace() {
			return editorPanels.clientHeight
				- generativeResizer.offsetHeight
				- editorHeader.offsetHeight;
		}

		function setGenerativeSplitByRatio(ratio) {
			var fullHeight = getGenerativeSplitSpace();
			if (fullHeight <= 0) return;
			var minH = 140;
			var next = Math.floor(fullHeight * ratio);
			next = Math.max(minH, Math.min(fullHeight - minH, next));
			generativePanel.style.height = next + 'px';
			monacoWrapper.style.flex = '0 0 auto';
			monacoWrapper.style.height = (fullHeight - next) + 'px';
		}

		function updateGenerativePanel(proc, triggerLayout) {
			var show = isGenerativeProc(proc);
			generativePanel.style.display = show ? 'flex' : 'none';
			generativeResizer.style.display = show ? 'block' : 'none';
			if (show) {
				var targetJs = proc.generativeJs || '';
				if (generativeJsModel.getValue() !== targetJs) {
					suppressModelChg = true;
					generativeJsModel.setValue(targetJs);
					suppressModelChg = false;
				}
				if (!monacoWrapper.style.height) setGenerativeSplitByRatio(0.5);
			} else {
				monacoWrapper.style.flex = '1';
				monacoWrapper.style.height = '';
				generativePanel.style.height = '';
			}
			setGenerativeErrorOverlay(proc);
			if (triggerLayout) {
				setTimeout(function () {
					generativeEditor.layout();
				}, 0);
			}
		}

		function updateHeaderToggles(proc) {
			var show = rollbackVisible && currentIdx >= 0 && proc;
			var isGenerative = isGenerativeProc(proc);
			btnShowDiff.style.display = show ? '' : 'none';
			btnEditable.style.display = show && !isGenerative ? '' : 'none';
			btnGenerateRollback.style.display = show && !isGenerative ? '' : 'none';
			if (!show) return;
			var showDiff = proc.showDiff !== false;
			var editable = proc.editable === true;
			btnShowDiff.querySelector('span').textContent = 'Diff: ' + (showDiff ? 'On' : 'Off');
			btnShowDiff.classList.toggle('active', showDiff);
			if (isGenerative) return;
			btnEditable.querySelector('span').textContent = 'Rollback: ' + (editable ? 'Editable' : 'Read-only');
			btnEditable.classList.toggle('active', editable);
			btnGenerateRollback.disabled = !editable;
		}

		// ── Button: Generate Rollback ───────────────────────────────────────────
		btnGenerateRollback.addEventListener('click', async function () {
			const proc = procedures[currentIdx];
			if (isGenerativeProc(proc)) return;
			if (proc.original?.trim() !== '') {
				if (!(await showWarningMessage(
					`Generate rollback for "${proc.name}"\n\n`
					+ `This will overwrite your current rollback for this procedure. `
					+ `We recommend copying it elsewhere before continuing. `,
					'Generate & Overwrite'
				))) return;
			}
			proc.original = generateRollbackScript(proc.edited);
			originalModel.setValue(proc.original)
		});

		// ── Toggle: Show Diff ───────────────────────────────────────────────────
		btnShowDiff.addEventListener('click', function () {
			if (currentIdx < 0) return;
			var proc   = procedures[currentIdx];
			var newVal = proc.showDiff === false;
			proc.showDiff = newVal;
			proc.rollbackOptions = Object.assign({}, proc.rollbackOptions, { showDiff: newVal });
			updateHeaderToggles(proc);
			applyMode(true);
			vscode.postMessage({ type: 'setOption', name: proc.name, option: 'showDiff', value: newVal });
		});

		// ── Toggle: Rollback Editable ───────────────────────────────────────────
		btnEditable.addEventListener('click', function () {
			if (currentIdx < 0) return;
			var proc   = procedures[currentIdx];
			if (isGenerativeProc(proc)) return;
			var newVal = proc.editable !== true;
			proc.editable = newVal;
			proc.rollbackOptions = Object.assign({}, proc.rollbackOptions, { editable: newVal });
			updateHeaderToggles(proc);
			applyEditableState(proc);
			vscode.postMessage({ type: 'setOption', name: proc.name, option: 'editable', value: newVal });
		});

		// ── Toggle: Hide / Show Rollback panel ─────────────────────────────────
		toggleBtn.addEventListener('click', function () {
			rollbackVisible = !rollbackVisible;
			vscode.postMessage({ type: 'saveDiffState', rollbackVisible: rollbackVisible });
			applyMode(true);
			updateHeaderToggles(currentIdx >= 0 ? procedures[currentIdx] : null);
		});

		generativeResizer.addEventListener('mousedown', function (e) {
			if (currentIdx < 0 || !isGenerativeProc(procedures[currentIdx])) return;
			e.preventDefault();
			var total = getGenerativeSplitSpace();
			dragState = {
				startY: e.clientY,
				startTop: generativePanel.offsetHeight,
				total: total
			};
		});

		window.addEventListener('mousemove', function (e) {
			if (!dragState) return;
			var minH = 140;
			var next = dragState.startTop + (e.clientY - dragState.startY);
			next = Math.max(minH, Math.min(dragState.total - minH, next));
			generativePanel.style.height = next + 'px';
			monacoWrapper.style.flex = '0 0 auto';
			monacoWrapper.style.height = (dragState.total - next) + 'px';
			generativeEditor.layout();
			var mode = getCurrentMode();
			if (mode === 'diff') diffEditor.layout();
			if (mode === 'plain') plainEditor.layout();
			if (mode === 'split') { splitLeftEditor.layout(); splitRightEditor.layout(); }
		});

		window.addEventListener('mouseup', function () {
			dragState = null;
		});

		window.addEventListener('resize', function () {
			if (currentIdx < 0 || !isGenerativeProc(procedures[currentIdx])) return;
			setGenerativeSplitByRatio(0.5);
			generativeEditor.layout();
		});

		// ── Sync modified (edited) model ────────────────────────────────────────
		var editTimer = null;
		modifiedModel.onDidChangeContent(function () {
			if (suppressModelChg || currentIdx < 0) return;
			procedures[currentIdx].edited = modifiedModel.getValue();
			refreshDots();
			clearTimeout(editTimer);
			vscode.postMessage({
				type: 'edit',
				name: procedures[currentIdx].name,
				body: modifiedModel.getValue(),
			});
		});

		// ── Sync original (rollback) model ──────────────────────────────────────
		var originalEditTimer = null;
		originalModel.onDidChangeContent(function () {
			if (suppressModelChg || currentIdx < 0) return;
			var proc = procedures[currentIdx];
			if (proc.editable !== true) return;
			proc.original = originalModel.getValue();
			clearTimeout(originalEditTimer);
			vscode.postMessage({
				type: 'editOriginal',
				name: proc.name,
				body: originalModel.getValue(),
			});
		});

		generativeJsModel.onDidChangeContent(function () {
			if (suppressModelChg || currentIdx < 0) return;
			var proc = procedures[currentIdx];
			if (!isGenerativeProc(proc)) return;
			proc.generativeJs = generativeJsModel.getValue();
			vscode.postMessage({
				type: 'editGenerativeJs',
				name: proc.name,
				body: proc.generativeJs,
			});
		});

		// ── Switch to a change ──────────────────────────────────────────────────
		function switchProc(i) {
			var isNewProc = (i !== currentIdx);
			currentIdx = i;
			var proc = procedures[i];

			procTitle.textContent       = proc.name;
			noSel.style.display         = 'none';
			monacoWrapper.style.display = 'block';

			var origChanged = originalModel.getValue() !== proc.original;
			var editChanged = modifiedModel.getValue() !== proc.edited;

			if (origChanged || editChanged) {
				suppressModelChg = true;
				if (origChanged) originalModel.setValue(proc.original);
				if (editChanged) modifiedModel.setValue(proc.edited);
				suppressModelChg = false;
				if (isNewProc) {
					diffEditor.getOriginalEditor().setScrollTop(0);
					diffEditor.getModifiedEditor().setScrollTop(0);
					plainEditor.setScrollTop(0);
					splitLeftEditor.setScrollTop(0);
					splitRightEditor.setScrollTop(0);
				}
			}

			setGeneratedSqlReadOnly(proc);
			applyEditableState(proc);
			updateGenerativePanel(proc, isNewProc);
			applyMode(isNewProc);
			updateHeaderToggles(proc);
			renderMiniMap();
			if (isNewProc) hideValidationBanner();
		}

		// ── Mini Map ────────────────────────────────────────────────────────────
		function renderMiniMap() {
			if (!procedures.length) {
				miniMap.innerHTML = '<div class="mini-map-empty">No changes added yet.</div>';
				return;
			}
			miniMap.innerHTML = '';
			procedures.forEach(function (proc, i) {
				var el = document.createElement('div');
				el.className = 'proc-item'
					+ (i === currentIdx              ? ' active'     : '')
					+ (proc.original !== proc.edited ? ' modified'   : '')
					+ (isGenerativeProc(proc)        ? ' generative' : '');
				el.title = proc.name + ' (Right-click for options)';

				var handle = document.createElement('span');
				handle.className   = 'drag-handle';
				handle.textContent = '☰';
				handle.title       = 'Drag to reorder';
				handle.addEventListener('mousedown', function (e) {
					e.stopPropagation();
					el.draggable = true;
				});

				var dot = document.createElement('span');
				dot.className = 'dot';
				dot.innerHTML = SPLOTCH_SVG;

				var label = document.createElement('span');
				label.style.overflow     = 'hidden';
				label.style.textOverflow = 'ellipsis';
				label.textContent = proc.name;

				el.appendChild(handle);
				el.appendChild(dot);
				el.appendChild(label);

				el.addEventListener('click', (function (idx) {
					return function () { switchProc(idx); };
				})(i));

				el.addEventListener('contextmenu', (function (idx) {
					return function (e) {
						e.preventDefault();
						showContextMenu(e, idx);
					};
				})(i));

				el.draggable = false;

				el.addEventListener('dragstart', (function (idx) {
					return function (e) {
						dragSrcIdx = idx;
						e.dataTransfer.effectAllowed = 'move';
						el.classList.add('dragging');
					};
				})(i));

				el.addEventListener('dragend', function () {
					el.draggable = false;
					el.classList.remove('dragging');
					clearDragClasses();
					dragSrcIdx = -1;
				});

				el.addEventListener('dragover', (function (idx, node) {
					return function (e) {
						if (dragSrcIdx < 0 || dragSrcIdx === idx) return;
						e.preventDefault();
						e.dataTransfer.dropEffect = 'move';
						clearDragClasses();
						node.classList.add(idx < dragSrcIdx ? 'drag-over-above' : 'drag-over-below');
					};
				})(i, el));

				el.addEventListener('dragleave', function () { clearDragClasses(); });

				el.addEventListener('drop', (function (toIdx) {
					return function (e) {
						e.preventDefault();
						if (dragSrcIdx < 0 || dragSrcIdx === toIdx) return;
						vscode.postMessage({ type: 'reorder', fromIdx: dragSrcIdx, toIdx: toIdx });
						dragSrcIdx = -1;
						clearDragClasses();
					};
				})(i));

				miniMap.appendChild(el);
			});
		}

		function clearDragClasses() {
			miniMap.querySelectorAll('.proc-item').forEach(function (el) {
				el.classList.remove('drag-over-above', 'drag-over-below');
			});
		}

		function refreshDots() {
			miniMap.querySelectorAll('.proc-item').forEach(function (el, i) {
				if (!procedures[i]) return;
				el.classList.toggle('modified', procedures[i].original !== procedures[i].edited);
				el.classList.toggle('generative', isGenerativeProc(procedures[i]));
			});
		}

		// ── Validation banner ───────────────────────────────────────────────────
		function showValidationBanner(msg) {
			validationBanner.textContent   = '\u26A0 ' + msg;
			validationBanner.style.display = 'block';
		}
		function hideValidationBanner() {
			validationBanner.style.display = 'none';
		}

		// ── Context menu ─────────────────────────────────────────────────────────
		var ctxMenuIdx = -1;

		function showContextMenu(e, idx) {
			ctxMenuIdx = idx;
			var proc = procedures[idx];
			$('ctx-refetch').style.display = proc.isNew ? 'none'  : 'block';
			$('ctx-rename').style.display  = proc.isNew ? 'block' : 'none';
			ctxMenuEl.style.left    = '-9999px';
			ctxMenuEl.style.display = 'block';
			var mw = ctxMenuEl.offsetWidth  || 224;
			var mh = ctxMenuEl.offsetHeight || 100;
			var x  = Math.min(e.clientX, window.innerWidth  - mw - 6);
			var y  = Math.min(e.clientY, window.innerHeight - mh - 6);
			ctxMenuEl.style.left = x + 'px';
			ctxMenuEl.style.top  = y + 'px';
		}

		function closeContextMenu() {
			ctxMenuEl.style.display = 'none';
			ctxMenuIdx = -1;
		}

		document.addEventListener('mousedown', function (e) {
			if (!ctxMenuEl.contains(e.target)) closeContextMenu();
			if (!addDropdown.contains(e.target) && !$('btn-add').contains(e.target))
				closeAddDropdown();
		});
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape') { closeContextMenu(); closeAddDropdown(); }
		});

		$('ctx-refetch').addEventListener('click', function () {
			if (ctxMenuIdx < 0) return;
			var name = procedures[ctxMenuIdx].name;
			closeContextMenu();
			vscode.postMessage({ type: 'refreshProcedure', name: name });
		});

		$('ctx-rename').addEventListener('click', function () {
			if (ctxMenuIdx < 0) return;
			var name = procedures[ctxMenuIdx].name;
			closeContextMenu();
			vscode.postMessage({ type: 'renameProcedure', name: name });
		});

		$('ctx-remove').addEventListener('click', function () {
			if (ctxMenuIdx < 0) return;
			var name = procedures[ctxMenuIdx].name;
			closeContextMenu();
			vscode.postMessage({ type: 'removeProc', name: name });
		});

		// ── Add Change dropdown ──────────────────────────────────────────────────
		$('btn-add').addEventListener('click', function (e) {
			e.stopPropagation();
			if (addDropdown.style.display === 'block') {
				closeAddDropdown();
				return;
			}
			// Position below the button
			var rect = $('btn-add').getBoundingClientRect();
			addDropdown.style.display = 'block';
			addDropdown.style.left    = '-9999px';
			var dw = addDropdown.offsetWidth || 210;
			var x  = Math.min(rect.left, window.innerWidth - dw - 6);
			addDropdown.style.left = x + 'px';
			addDropdown.style.top  = (rect.bottom + 4) + 'px';
		});

		function closeAddDropdown() {
			addDropdown.style.display = 'none';
		}

		// Option 1: Custom — blank entry, switch immediately
		$('opt-custom').addEventListener('click', function () {
			closeAddDropdown();
			vscode.postMessage({ type: 'createCustomChange' });
		});

		// Option 2: Column + History Table — open column modal
		$('opt-column').addEventListener('click', function () {
			closeAddDropdown();
			openColumnModal();
		});

		// Option 3: Stored Procedure — existing search/create dialog
		$('opt-procedure').addEventListener('click', function () {
			closeAddDropdown();
			showSearchView();
			searchOverlay.style.display = 'flex';
			setTimeout(function () { procSearchInput.focus(); }, 30);
			vscode.postMessage({ type: 'searchProcedures', query: '' });
		});

		// Option 4: Generative Change
		$('opt-generative').addEventListener('click', function () {
			closeAddDropdown();
			vscode.postMessage({ type: 'createGenerativeChange' });
		});

		// ── Column + History Table modal ─────────────────────────────────────────

		function openColumnModal() {
			setTimeout(function () { tableSearchInput.focus(); }, 30);
			tableSearchResults.innerHTML  = '<div class="no-results">Loading&#x2026;</div>';
			colTable.value              = '';
			colName.value               = '';
			colType.value               = '';
			colDefault.value            = '';
			columnError.style.display   = 'none';
			columnOverlay.style.display = 'flex';
			vscode.postMessage({ type: 'searchTables', query: '' });
			setTimeout(function () { tableSearchInput.focus(); }, 30);
		}

		function closeColumnModal() {
			columnOverlay.style.display = 'none';
		}

		
		var tableSearchTimer = null;
		tableSearchInput.addEventListener('input', function () {
			clearTimeout(tableSearchTimer);
			tableSearchTimer = setTimeout(function () {
				selectTable(null);
				vscode.postMessage({ type: 'searchTables', query: tableSearchInput.value.trim() });
			}, 250);
		});

		function selectTable(tableName) {
			let previouslySelected = colTable.value;
			console.log('previouslySelected:', previouslySelected);
			colTable.value = '';
			
			tableSearchResults.querySelectorAll('.badge.selected').forEach(b => b.remove());
			if (!tableName || previouslySelected===tableName) return;

			let selectedEl = Array.from(tableSearchResults.children).find(c => c.innerText === tableName);
			if (!selectedEl) return;

			let badge = document.createElement('span');
			badge.className = 'badge selected';
			badge.innerHTML = '&check;';
			selectedEl.appendChild(badge);

			colTable.value = tableName;
		}

		$('column-close').addEventListener('click', closeColumnModal);
		$('btn-column-cancel').addEventListener('click', closeColumnModal);
		columnOverlay.addEventListener('click', function (e) {
			if (e.target === columnOverlay) closeColumnModal();
		});

		$('btn-column-confirm').addEventListener('click', confirmColumn);
		colDefault.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') confirmColumn();
		});

		function confirmColumn() {
			columnError.style.display = 'none';
			var table      = colTable.value.trim();
			var name       = colName.value.trim();
			var type       = colType.value.trim();
			var defaultVal = colDefault.value.trim();

			if (!table) {
				columnError.textContent   = 'Please select a table.';
				columnError.style.display = 'block';
				return;
			}
			if (!name) {
				columnError.textContent   = 'Please enter a column name.';
				columnError.style.display = 'block';
				return;
			}
			if (!type) {
				columnError.textContent   = 'Please enter a column type.';
				columnError.style.display = 'block';
				return;
			}

			closeColumnModal();
			vscode.postMessage({
				type:       'createColumnChange',
				table:      table,
				columnName: name,
				columnType: type,
				defaultVal: defaultVal || null,
			});
		}

		// ── Messages from extension host ────────────────────────────────────────
		window.addEventListener('message', function (event) {
			var data = event.data;
			switch (data.type) {

				case 'showWarningMessageResponse': {
					break;
				}

				case 'init': {
					if (typeof data.rollbackVisible === 'boolean') {
						rollbackVisible = data.rollbackVisible;
					}
					var prevName = (currentIdx >= 0 && procedures[currentIdx])
						? procedures[currentIdx].name : null;
					procedures = data.procedures;
					var newIdx  = prevName
						? procedures.findIndex(function (p) { return p.name === prevName; })
						: -1;
					var nextIdx = newIdx >= 0 ? newIdx : (procedures.length > 0 ? 0 : -1);

					if (data.switchToIdx || data.switchToIdx === 0) {
						switchProc(data.switchToIdx);
					} else if (nextIdx >= 0) {
						switchProc(nextIdx);
					} else {
						currentIdx = -1;
						noSel.style.display         = 'flex';
						monacoWrapper.style.display = 'none';
						updateGenerativePanel(null, false);
						procTitle.textContent       = 'No change selected';
						applyMode(false);
						updateHeaderToggles(null);
						renderMiniMap();
					}
					break;
				}

				case 'procSearchResults':
					renderSearchResults(procSearchResults, data.results, (name, index) => {
						vscode.postMessage({ type: 'fetchProcedure', name: name });
						closeProcSearch();
					});
					break;

				case 'tableSearchResults':
					renderSearchResults(tableSearchResults, data.results, (name, index) => {
						selectTable(name, index);
					});
					break;
			}
		});


		function renderSearchResults(container, results, clickCallback) {
			container.innerHTML = '';
			if (!results.length) {
				container.innerHTML = '<div class="no-results">No results found.</div>';
				return;
			}
			results.forEach(function (name, i) {
				var isAdded = procedures.some(function (p) { return p.name === name; });
				var el      = document.createElement('div');
				el.className = 'result-item' + (isAdded ? ' added' : '');
				el.innerHTML = '<span>' + esc(name) + '</span>'
					+ (isAdded ? '<span class="badge">Added</span>' : '');
				if (!isAdded) {
					el.addEventListener('click', () => clickCallback(name, i));
				}
				container.appendChild(el);
			});
		}

		// ── Toolbar ──────────────────────────────────────────────────────────────
		$('btn-view').addEventListener('click', function () {
			vscode.postMessage({ type: 'viewChangeScript' });
		});
		$('btn-copy-clean-sql').addEventListener('click', function () {
			vscode.postMessage({ type: 'copyCleanSql' });
		});

		// ── Search dialog ─────────────────────────────────────────────────────────
		$('search-close').addEventListener('click', closeProcSearch);
		searchOverlay.addEventListener('click', function (e) {
			if (e.target === searchOverlay) closeProcSearch();
		});

		function closeProcSearch() {
			searchOverlay.style.display = 'none';
			showSearchView();
		}

		function showSearchView() {
			searchView.style.display  = 'flex';
			createView.style.display  = 'none';
			procSearchInput.value         = '';
			procSearchResults.innerHTML   = '<div class="no-results">Loading&#x2026;</div>';
		}

		var proSearchTimer = null;
		procSearchInput.addEventListener('input', function () {
			clearTimeout(proSearchTimer);
			proSearchTimer = setTimeout(function () {
				vscode.postMessage({ type: 'searchProcedures', query: procSearchInput.value.trim() });
			}, 250);
		});

		// ── Create-new procedure sub-view ─────────────────────────────────────────
		$('btn-create-new').addEventListener('click', function () {
			searchView.style.display  = 'none';
			createView.style.display  = 'flex';
			createInput.value         = '';
			createError.style.display = 'none';
			setTimeout(function () { createInput.focus(); }, 30);
		});

		$('btn-create-cancel').addEventListener('click', showSearchView);

		$('btn-create-confirm').addEventListener('click', confirmCreate);
		createInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') confirmCreate();
		});

		function confirmCreate() {
			var name = createInput.value.trim();
			createError.style.display = 'none';
			if (!name) {
				createError.textContent   = 'Please enter a procedure name.';
				createError.style.display = 'block';
				return;
			}
			if (procedures.some(function (p) { return p.name === name; })) {
				createError.textContent   = 'A change with that name is already in this change script.';
				createError.style.display = 'block';
				return;
			}
			vscode.postMessage({ type: 'createProcedure', name: name });
			closeProcSearch();
		}

		// ── Utility ───────────────────────────────────────────────────────────────
		function esc(s) {
			return String(s)
				.replace(/&/g, '&amp;').replace(/</g, '&lt;')
				.replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		}

		// ── Boot ──────────────────────────────────────────────────────────────────
		vscode.postMessage({ type: 'ready' });

	}); // end require
})();
