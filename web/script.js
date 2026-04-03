(function () {
	'use strict';

	require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });

	require(['vs/editor/editor.main'], function (monaco) {

		var vscode = acquireVsCodeApi();

		// rollbackVisible is seeded from the extension host's globalState via the first
		// 'init' message. We keep a local copy here for immediate toggle response.
		var rollbackVisible = true; // overwritten on first 'init'

		// ── Runtime state ──────────────────────────────────
		/** @type {{ name: string, original: string, edited: string, isNew: boolean }[]} */
		var procedures = [];
		var currentIdx = -1;
		var suppressModelChg = false;   // prevent edit-loop when we call setValue
		var dragSrcIdx = -1;

		// ── DOM refs ────────────────────────────────────────
		function $(id) { return document.getElementById(id); }

		var miniMap = $('mini-map');
		var noSel = $('no-selection');
		var monacoWrapper = $('monaco-wrapper');
		var diffContainer = $('diff-container');
		var plainContainer = $('plain-container');
		var procTitle = $('proc-title');
		var toggleBtn = $('toggle-diff');
		var validationBanner = $('validation-banner');
		var ctxMenuEl = $('context-menu');
		var searchOverlay = $('search-overlay');
		var searchView = $('search-view');
		var createView = $('create-view');
		var searchInput = $('search-input');
		var searchResults = $('search-results');
		var createInput = $('create-input');
		var createError = $('create-error');

		// ── Monaco theme ────────────────────────────────────
		var isDark = document.body.classList.contains('vscode-dark')
			|| document.body.classList.contains('vscode-high-contrast');

		// ── Shared text models ──────────────────────────────
		var originalModel = monaco.editor.createModel('', 'sql');
		var modifiedModel = monaco.editor.createModel('', 'sql');

		// ── Diff editor ─────────────────────────────────────
		var diffEditor = monaco.editor.createDiffEditor(diffContainer, {
			automaticLayout: true,
			renderSideBySide: true,
			enableSplitViewResizing: true,
			originalEditable: false,
			readOnly: false,
			theme: isDark ? 'vs-dark' : 'vs',
			fontSize: 13,
			scrollBeyondLastLine: true,
			minimap: { enabled: false },
			lineNumbers: 'on',
			wordWrap: 'off',
			renderWhitespace: 'selection',
		});
		window.diffEditor = diffEditor;
		diffEditor.setModel({ original: originalModel, modified: modifiedModel });

		// ── Plain editor (no diff, same model) ──────────────
		var plainEditor = monaco.editor.create(plainContainer, {
			model: modifiedModel,
			automaticLayout: true,
			language: 'sql',
			theme: isDark ? 'vs-dark' : 'vs',
			fontSize: 13,
			scrollBeyondLastLine: true,
			minimap: { enabled: false },
			lineNumbers: 'on',
			wordWrap: 'off',
			renderWhitespace: 'selection',
		});

		// rollbackVisible is applied when the first 'init' message arrives from the host.

		// ── Sync edits to extension host (debounced) ────────
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

		// ── Toggle diff / plain ─────────────────────────────
		toggleBtn.addEventListener('click', function () {
			rollbackVisible = !rollbackVisible;
			vscode.postMessage({ type: 'saveDiffState', rollbackVisible: rollbackVisible });
			applyRollbackVisible(rollbackVisible, true);
		});

		function applyRollbackVisible(visible, triggerLayout) {
			diffContainer.style.display = visible ? 'block' : 'none';
			plainContainer.style.display = visible ? 'none' : 'block';
			toggleBtn.innerHTML = visible
				? '&#x25C0; Hide Rollback'
				: '&#x25B6; Show Rollback';
			if (triggerLayout) {
				setTimeout(function () {
					if (visible) diffEditor.layout();
					else plainEditor.layout();
				}, 0);
			}
		}

		// ── Switch to a procedure ───────────────────────────
		/**
		 * Display a procedure in the editor panes.
		 * Only calls setValue if content actually changed — preserves undo history
		 * and cursor position when called after a save that produced identical content.
		 * @param {number} i
		 */
		function switchProc(i) {
			var isNewProc = (i !== currentIdx);
			currentIdx = i;
			var proc = procedures[i];
			procTitle.textContent = proc.name;
			noSel.style.display = 'none';
			monacoWrapper.style.display = 'block';

			var origChanged = originalModel.getValue() !== proc.original;
			var editChanged = modifiedModel.getValue() !== proc.edited;

			if (origChanged || editChanged) {
				suppressModelChg = true;
				if (origChanged) originalModel.setValue(proc.original);
				if (editChanged) modifiedModel.setValue(proc.edited);
				suppressModelChg = false;

				// Only scroll to top when actually switching procedures,
				// not when the same proc's content was refreshed (e.g. after save).
				if (isNewProc) {
					diffEditor.getOriginalEditor().setScrollTop(0);
					diffEditor.getModifiedEditor().setScrollTop(0);
					plainEditor.setScrollTop(0);
				}
			}

			renderMiniMap();

			// Use the per-proc showDiff option to control diff/plain display.
			// If the proc doesn't want a diff (new procs default to showDiff:false),
			// collapse into single-pane view without decorations.
			var shouldShowDiff = (proc.showDiff !== false) && rollbackVisible;
			diffContainer.classList.toggle('no-diff', !shouldShowDiff);
			plainEditor.updateOptions({ readOnly: !isEditable });

			// Apply the per-proc editable option to the modified editor.
			var isEditable = proc.editable !== false;
			plainEditor.updateOptions({ readOnly: !isEditable });

			// Clear any validation error when switching procedures.
			if (isNewProc) hideValidationBanner();
		}

		// ── Mini Map ────────────────────────────────────────
		function renderMiniMap() {
			if (!procedures.length) {
				miniMap.innerHTML = '<div class="mini-map-empty">No procedures added yet.</div>';
				return;
			}
			miniMap.innerHTML = '';
			procedures.forEach(function (proc, i) {
				var el = document.createElement('div');
				el.className = 'proc-item'
					+ (i === currentIdx ? ' active' : '')
					+ (proc.original !== proc.edited ? ' modified' : '');
				el.title = proc.name + (proc.isNew ? ' (new)' : '')
					+ '\\nRight-click to re-fetch from DB';

				// Drag handle (☰)
				var handle = document.createElement('span');
				handle.className = 'drag-handle';
				handle.textContent = '☰';
				handle.title = 'Drag to reorder';
				handle.addEventListener('mousedown', function (e) {
					e.stopPropagation();
					el.draggable = true;
				});

				// Modified dot
				var dot = document.createElement('span');
				dot.className = 'dot';

				// Name label
				var label = document.createElement('span');
				label.style.overflow = 'hidden';
				label.style.textOverflow = 'ellipsis';
				label.textContent = proc.name + (proc.isNew ? ' ✦' : '');

				el.appendChild(handle);
				el.appendChild(dot);
				el.appendChild(label);

				// ── Click to select ──────────────────────────
				el.addEventListener('click', (function (idx) {
					return function () { switchProc(idx); };
				})(i));

				// ── Right-click to show context menu ─────────
				el.addEventListener('contextmenu', (function (idx) {
					return function (e) {
						e.preventDefault();
						showContextMenu(e, idx);
					};
				})(i));

				// ── Drag to reorder ──────────────────────────
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

		// ── Validation banner ─────────────────────────────
		function showValidationBanner(msg) {
			validationBanner.textContent = '\u26A0 ' + msg;
			validationBanner.style.display = 'block';
		}
		function hideValidationBanner() {
			validationBanner.style.display = 'none';
		}

		// ── Context menu ─────────────────────────────────
		var ctxMenuIdx = -1;

		function showContextMenu(e, idx) {
			ctxMenuIdx = idx;
			var proc = procedures[idx];
			// Show/hide items depending on whether this is a new or existing procedure.
			$('ctx-refetch').style.display = proc.isNew ? 'none' : 'block';
			$('ctx-rename').style.display = proc.isNew ? 'block' : 'none';
			// Show menu briefly off-screen to measure its size, then reposition.
			ctxMenuEl.style.left = '-9999px';
			ctxMenuEl.style.display = 'block';
			var mw = ctxMenuEl.offsetWidth || 224;
			var mh = ctxMenuEl.offsetHeight || 100;
			var x = Math.min(e.clientX, window.innerWidth - mw - 6);
			var y = Math.min(e.clientY, window.innerHeight - mh - 6);
			ctxMenuEl.style.left = x + 'px';
			ctxMenuEl.style.top = y + 'px';
		}

		function closeContextMenu() {
			ctxMenuEl.style.display = 'none';
			ctxMenuIdx = -1;
		}

		// Close on outside click or Escape.
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

		function refreshDots() {
			miniMap.querySelectorAll('.proc-item').forEach(function (el, i) {
				if (!procedures[i]) return;
				el.classList.toggle('modified', procedures[i].original !== procedures[i].edited);
			});
		}

		// ── Messages from extension host ────────────────────
		window.addEventListener('message', function (event) {
			var data = event.data;
			switch (data.type) {

				case 'init': {
					// Seed diff visibility from extension host globalState on (re)load.
					if (typeof data.rollbackVisible === 'boolean' && data.rollbackVisible !== rollbackVisible) {
						rollbackVisible = data.rollbackVisible;
						applyRollbackVisible(rollbackVisible, false);
					}
					var prevName = (currentIdx >= 0 && procedures[currentIdx])
						? procedures[currentIdx].name : null;
					procedures = data.procedures;
					var newIdx = prevName
						? procedures.findIndex(function (p) { return p.name === prevName; })
						: -1;
					var nextIdx = newIdx >= 0 ? newIdx : (procedures.length > 0 ? 0 : -1);
					if (nextIdx >= 0) {
						switchProc(nextIdx);
					} else {
						currentIdx = -1;
						noSel.style.display = 'flex';
						monacoWrapper.style.display = 'none';
						procTitle.textContent = 'No procedure selected';
						renderMiniMap();
					}
					break;
				}

				case 'searchResults':
					renderSearchResults(data.results);
					break;
			}
		});

		// ── Toolbar ─────────────────────────────────────────
		$('btn-add').addEventListener('click', function () {
			showSearchView();
			searchOverlay.style.display = 'flex';
			setTimeout(function () { searchInput.focus(); }, 30);
			vscode.postMessage({ type: 'searchProcedures', query: '' });
		});

		$('btn-view').addEventListener('click', function () {
			vscode.postMessage({ type: 'viewChangeScript' });
		});

		// ── Search dialog ────────────────────────────────────
		$('search-close').addEventListener('click', closeSearch);
		searchOverlay.addEventListener('click', function (e) {
			if (e.target === searchOverlay) closeSearch();
		});

		function closeSearch() {
			searchOverlay.style.display = 'none';
			showSearchView();
		}

		function showSearchView() {
			searchView.style.display = 'flex';
			createView.style.display = 'none';
			searchInput.value = '';
			searchResults.innerHTML = '';
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
				var el = document.createElement('div');
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

		// ── Create-new procedure sub-view ────────────────────
		$('btn-create-new').addEventListener('click', function () {
			searchView.style.display = 'none';
			createView.style.display = 'flex';
			createInput.value = '';
			createError.style.display = 'none';
			setTimeout(function () { createInput.focus(); }, 30);
		});

		$('btn-create-cancel').addEventListener('click', function () {
			showSearchView();
		});

		$('btn-create-confirm').addEventListener('click', confirmCreate);
		createInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') confirmCreate();
		});

		function confirmCreate() {
			var name = createInput.value.trim();
			createError.style.display = 'none';
			if (!name) {
				createError.textContent = 'Please enter a procedure name.';
				createError.style.display = 'block';
				return;
			}
			if (procedures.some(function (p) { return p.name === name; })) {
				createError.textContent = 'A procedure with that name is already in this change script.';
				createError.style.display = 'block';
				return;
			}
			vscode.postMessage({ type: 'createProcedure', name: name });
			closeSearch();
		}

		// ── Utility ──────────────────────────────────────────
		function esc(s) {
			return String(s)
				.replace(/&/g, '&amp;').replace(/</g, '&lt;')
				.replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		}

		// ── Boot ─────────────────────────────────────────────
		vscode.postMessage({ type: 'ready' });

	}); // end require
})();
