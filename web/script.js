(function () {
	'use strict';

	require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });

	require(['vs/editor/editor.main'], function (monaco) {

		var vscode = acquireVsCodeApi();

		// ── Global display state ───────────────────────────────────────────────
		// Seeded from extension host globalState via the first 'init' message.
		var rollbackVisible = true;

		// ── Runtime state ──────────────────────────────────────────────────────
		/** @type {{ name: string, original: string, edited: string, isNew: boolean,
		 *           showDiff: boolean, editable: boolean,
		 *           updateOptions: {}, rollbackOptions: {} }[]} */
		var procedures       = [];
		var currentIdx       = -1;
		var suppressModelChg = false;
		var dragSrcIdx       = -1;

		// ── DOM refs ───────────────────────────────────────────────────────────
		function $(id) { return document.getElementById(id); }

		var miniMap          = $('mini-map');
		var noSel            = $('no-selection');
		var monacoWrapper    = $('monaco-wrapper');
		var diffContainer    = $('diff-container');
		var plainContainer   = $('plain-container');
		var splitContainer   = $('split-container');
		var splitLeft        = $('split-left');
		var splitRight       = $('split-right');
		var procTitle        = $('proc-title');
		var toggleBtn        = $('toggle-diff');
		var btnShowDiff      = $('btn-toggle-show-diff');
		var btnEditable      = $('btn-toggle-editable');
		var validationBanner = $('validation-banner');
		var ctxMenuEl        = $('context-menu');
		var searchOverlay    = $('search-overlay');
		var searchView       = $('search-view');
		var createView       = $('create-view');
		var searchInput      = $('search-input');
		var searchResults    = $('search-results');
		var createInput      = $('create-input');
		var createError      = $('create-error');

		// ── Monaco theme ────────────────────────────────────────────────────────
		var isDark = document.body.classList.contains('vscode-dark')
			|| document.body.classList.contains('vscode-high-contrast');
		var monacoTheme = isDark ? 'vs-dark' : 'vs';

		// ── Shared text models ──────────────────────────────────────────────────
		// All editors share these two models so content stays in sync automatically.
		var originalModel = monaco.editor.createModel('', 'sql');
		var modifiedModel = monaco.editor.createModel('', 'sql');

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
			renderSideBySide:       true,
			enableSplitViewResizing: true,
			originalEditable:       false,   // updated per-proc via applyEditableState()
			readOnly:               false,
		}));
		diffEditor.setModel({ original: originalModel, modified: modifiedModel });

		// ── Plain editor  (rollbackVisible=false) ───────────────────────────────
		var plainEditor = monaco.editor.create(plainContainer, Object.assign({}, commonOpts, {
			model:    modifiedModel,
			language: 'sql',
		}));

		// ── Split editors  (rollbackVisible=true, showDiff=false) ───────────────
		// Left = update / edited side (always read-write).
		// Right = rollback / original side (readOnly toggled per-proc).
		var splitLeftEditor = monaco.editor.create(splitLeft, Object.assign({}, commonOpts, {
			model:    modifiedModel,
			language: 'sql',
		}));
		var splitRightEditor = monaco.editor.create(splitRight, Object.assign({}, commonOpts, {
			model:    originalModel,
			language: 'sql',
			readOnly: true,   // default; overridden by applyEditableState()
		}));

		// ── Display mode ────────────────────────────────────────────────────────
		// Three modes:
		//   'plain' – single editor (rollbackVisible=false)
		//   'diff'  – Monaco diff editor (rollbackVisible=true, showDiff=true)
		//   'split' – two plain editors side-by-side (rollbackVisible=true, showDiff=false)

		function getCurrentMode() {
			if (!rollbackVisible || currentIdx < 0) return 'plain';
			return procedures[currentIdx].showDiff !== false ? 'diff' : 'split';
		}

		/**
		 * Show the correct editor container and update the rollback toggle button label.
		 * @param {boolean} triggerLayout  Call layout() on the active editor after switching.
		 */
		function applyMode(triggerLayout) {
			var mode = getCurrentMode();
			diffContainer.style.display  = mode === 'diff'  ? 'block' : 'none';
			plainContainer.style.display = mode === 'plain' ? 'block' : 'none';
			splitContainer.style.display = mode === 'split' ? 'flex'  : 'none';

			toggleBtn.innerHTML = rollbackVisible
				? '&#x25C0; Hide Rollback'
				: '&#x25B6; Show Rollback';

			if (triggerLayout) {
				setTimeout(function () {
					if (mode === 'diff')  { diffEditor.layout(); }
					if (mode === 'plain') { plainEditor.layout(); }
					if (mode === 'split') { splitLeftEditor.layout(); splitRightEditor.layout(); }
				}, 0);
			}
		}

		// ── Per-proc option helpers ─────────────────────────────────────────────

		/** Apply the proc's editable option to the original-side editors. */
		function applyEditableState(proc) {
			var editable = proc.editable === true;
			// Diff editor's original pane
			diffEditor.getOriginalEditor().updateOptions({ readOnly: !editable });
			// Split right pane
			splitRightEditor.updateOptions({ readOnly: !editable });
		}

		/** Refresh the labels and active state of the header toggle buttons. */
		function updateHeaderToggles(proc) {
			var show = rollbackVisible && currentIdx >= 0 && proc;
			btnShowDiff.style.display = show ? '' : 'none';
			btnEditable.style.display = show ? '' : 'none';
			if (!show) return;

			var showDiff = proc.showDiff !== false;
			var editable = proc.editable === true;

			btnShowDiff.querySelector('span').textContent = 'Diff: ' + (showDiff ? 'On' : 'Off');
			btnShowDiff.classList.toggle('active', showDiff);

			btnEditable.querySelector('span').textContent = 'Rollback: ' + (editable ? 'Editable' : 'Read-only');
			btnEditable.classList.toggle('active', editable);
		}

		// ── Toggle: Show Diff ───────────────────────────────────────────────────
		btnShowDiff.addEventListener('click', function () {
			if (currentIdx < 0) return;
			var proc   = procedures[currentIdx];
			var newVal = proc.showDiff === false;   // false → true, true/undefined → false
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
			var newVal = proc.editable !== true;    // false/undefined → true, true → false
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

		// ── Sync modified (edited) model changes to extension host ──────────────
		var editTimer = null;
		modifiedModel.onDidChangeContent(function () {
			if (suppressModelChg || currentIdx < 0) return;
			procedures[currentIdx].edited = modifiedModel.getValue();
			refreshDots();
			clearTimeout(editTimer);
			editTimer = setTimeout(function () {
				vscode.postMessage({
					type: 'edit',
					name: procedures[currentIdx].name,
					body: modifiedModel.getValue(),
				});
			}, 300);
		});

		// ── Sync original (rollback) model changes to extension host ────────────
		// Only fires when the proc is marked editable=true.
		var originalEditTimer = null;
		originalModel.onDidChangeContent(function () {
			if (suppressModelChg || currentIdx < 0) return;
			var proc = procedures[currentIdx];
			if (proc.editable !== true) return;
			proc.original = originalModel.getValue();
			clearTimeout(originalEditTimer);
			originalEditTimer = setTimeout(function () {
				vscode.postMessage({
					type: 'editOriginal',
					name: proc.name,
					body: originalModel.getValue(),
				});
			}, 300);
		});

		// ── Switch to a procedure ───────────────────────────────────────────────
		function switchProc(i) {
			var isNewProc = (i !== currentIdx);
			currentIdx = i;
			var proc = procedures[i];

			procTitle.textContent      = proc.name;
			noSel.style.display        = 'none';
			monacoWrapper.style.display = 'block';

			// Only call setValue when content actually differs — preserves undo
			// history and cursor position on saves that produce identical text.
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

			applyEditableState(proc);
			applyMode(isNewProc);
			updateHeaderToggles(proc);
			renderMiniMap();

			if (isNewProc) hideValidationBanner();
		}

		// ── Mini Map ────────────────────────────────────────────────────────────
		function renderMiniMap() {
			if (!procedures.length) {
				miniMap.innerHTML = '<div class="mini-map-empty">No procedures added yet.</div>';
				return;
			}
			miniMap.innerHTML = '';
			procedures.forEach(function (proc, i) {
				var el = document.createElement('div');
				el.className = 'proc-item'
					+ (i === currentIdx              ? ' active'   : '')
					+ (proc.original !== proc.edited ? ' modified' : '');
				el.title = proc.name + (proc.isNew ? ' (new)' : '')
					+ '\nRight-click for options';

				// Drag handle (☰)
				var handle = document.createElement('span');
				handle.className   = 'drag-handle';
				handle.textContent = '☰';
				handle.title       = 'Drag to reorder';
				handle.addEventListener('mousedown', function (e) {
					e.stopPropagation();
					el.draggable = true;
				});

				// Modified dot
				var dot = document.createElement('span');
				dot.className = 'dot';

				// Name label
				var label = document.createElement('span');
				label.style.overflow     = 'hidden';
				label.style.textOverflow = 'ellipsis';
				label.textContent = proc.name + (proc.isNew ? ' ✦' : '');

				el.appendChild(handle);
				el.appendChild(dot);
				el.appendChild(label);

				// Click to select
				el.addEventListener('click', (function (idx) {
					return function () { switchProc(idx); };
				})(i));

				// Right-click: context menu
				el.addEventListener('contextmenu', (function (idx) {
					return function (e) {
						e.preventDefault();
						showContextMenu(e, idx);
					};
				})(i));

				// Drag to reorder
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
		});
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape') closeContextMenu();
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

		// ── Messages from extension host ────────────────────────────────────────
		window.addEventListener('message', function (event) {
			var data = event.data;
			switch (data.type) {

				case 'init': {
					// Seed rollback visibility from globalState on every (re)load.
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

					if (data.switchToIdx || data.switchToIdx===0) {
						switchProc(data.switchToIdx);
					} else if (nextIdx >= 0) {
						switchProc(nextIdx);
					} else {
						currentIdx = -1;
						noSel.style.display         = 'flex';
						monacoWrapper.style.display = 'none';
						procTitle.textContent       = 'No procedure selected';
						applyMode(false);
						updateHeaderToggles(null);
						renderMiniMap();
					}
					break;
				}

				case 'searchResults':
					renderSearchResults(data.results);
					break;
			}
		});

		// ── Toolbar ──────────────────────────────────────────────────────────────
		$('btn-add').addEventListener('click', function () {
			showSearchView();
			searchOverlay.style.display = 'flex';
			setTimeout(function () { searchInput.focus(); }, 30);
			vscode.postMessage({ type: 'searchProcedures', query: '' });
		});

		$('btn-view').addEventListener('click', function () {
			vscode.postMessage({ type: 'viewChangeScript' });
		});

		// ── Search dialog ─────────────────────────────────────────────────────────
		$('search-close').addEventListener('click', closeSearch);
		searchOverlay.addEventListener('click', function (e) {
			if (e.target === searchOverlay) closeSearch();
		});

		function closeSearch() {
			searchOverlay.style.display = 'none';
			showSearchView();
		}

		function showSearchView() {
			searchView.style.display  = 'flex';
			createView.style.display  = 'none';
			searchInput.value         = '';
			searchResults.innerHTML   = '';
		}

		var searchTimer = null;
		searchInput.addEventListener('input', function () {
			clearTimeout(searchTimer);
			searchTimer = setTimeout(function () {
				vscode.postMessage({ type: 'searchProcedures', query: searchInput.value.trim() });
			}, 250);
		});

		function renderSearchResults(results) {
			searchResults.innerHTML = '';
			if (!results.length) {
				searchResults.innerHTML = '<div class="no-results">No procedures found.</div>';
				return;
			}
			results.forEach(function (name) {
				var isAdded = procedures.some(function (p) { return p.name === name; });
				var el      = document.createElement('div');
				el.className = 'result-item' + (isAdded ? ' added' : '');
				el.innerHTML = '<span>' + esc(name) + '</span>'
					+ (isAdded ? '<span class="badge">Added</span>' : '');
				if (!isAdded) {
					el.addEventListener('click', function () {
						vscode.postMessage({ type: 'fetchProcedure', name: name });
						closeSearch();
					});
				}
				searchResults.appendChild(el);
			});
		}

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
				createError.textContent   = 'A procedure with that name is already in this change script.';
				createError.style.display = 'block';
				return;
			}
			vscode.postMessage({ type: 'createProcedure', name: name });
			closeSearch();
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