(function () {
  'use strict';

  // -- Project root directory handle (File System Access API + IndexedDB persistence) --
  var rootDirHandle = null;
  var DB_NAME = 'codeindex-viewer';
  var STORE_NAME = 'handles';
  var HANDLE_KEY = 'projectRoot';

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(STORE_NAME);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function saveHandle(handle) {
    var db = await openDB();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  async function loadHandle() {
    var db = await openDB();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, 'readonly');
      var req = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { resolve(null); };
    });
  }

  async function restoreHandle() {
    var handle = await loadHandle();
    if (!handle) return false;
    var perm = await handle.queryPermission({ mode: 'read' });
    if (perm === 'granted') {
      rootDirHandle = handle;
      return true;
    }
    return handle;
  }

  function promptForProjectRoot() {
    if (!window.showDirectoryPicker || document.getElementById('codeindex-root-banner')) return;

    var banner = document.createElement('div');
    banner.id = 'codeindex-root-banner';
    banner.innerHTML =
      '<span>Click to select the project root directory for source code viewing</span>' +
      '<button id="codeindex-pick-root">Open Project Folder</button>';
    document.body.prepend(banner);

    document.getElementById('codeindex-pick-root').addEventListener('click', async function () {
      try {
        var handle = await window.showDirectoryPicker({ mode: 'read' });
        rootDirHandle = handle;
        await saveHandle(handle);
        banner.remove();
      } catch (e) {}
    });
  }

  async function readFileFromRoot(relativePath) {
    if (!rootDirHandle) return null;
    var parts = relativePath.split('/').filter(Boolean);
    var current = rootDirHandle;
    try {
      for (var i = 0; i < parts.length - 1; i++) {
        current = await current.getDirectoryHandle(parts[i]);
      }
      var fileHandle = await current.getFileHandle(parts[parts.length - 1]);
      var file = await fileHandle.getFile();
      return await file.text();
    } catch (e) {
      return null;
    }
  }

  // -- Load mermaid from CDN and render diagrams --
  function loadMermaid() {
    var script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
    script.onload = function () {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
      mermaid.run().then(function () {
        attachMermaidZoomControls();
        attachClickHandlers();
      });
    };
    document.head.appendChild(script);
  }

  // -- Source panel setup --
  var sourceMap = window.__sourceMap || {};
  var panel = document.getElementById('source-panel');
  var layoutWrapped = false;

  function ensureLayout() {
    if (layoutWrapped) return document.querySelector('.codeindex-main');

    var previousScrollTop = window.pageYOffset ||
      document.documentElement.scrollTop ||
      document.body.scrollTop ||
      0;

    layoutWrapped = true;
    var main = document.createElement('div');
    main.className = 'codeindex-main';
    var children = Array.from(document.body.childNodes);
    children.forEach(function (child) {
      if (child === panel || (child.tagName && child.tagName === 'SCRIPT')) return;
      main.appendChild(child);
    });
    document.body.insertBefore(main, panel);
    document.body.classList.add('codeindex-layout');

    window.scrollTo(0, 0);
    main.scrollTop = previousScrollTop;
    requestAnimationFrame(function () {
      main.scrollTop = previousScrollTop;
    });

    return main;
  }

  if (panel) {
    var headerEl = document.getElementById('source-header');
    var monacoContainer = document.getElementById('monaco-container');
    var editor = null;
    var monacoReady = false;

    headerEl.innerHTML =
      '<span><span class="file-path"></span> <span class="line-range"></span></span>' +
      '<button id="source-close">&times;</button>';

    document.getElementById('source-close').addEventListener('click', function () {
      panel.classList.remove('visible');
    });
  }

  function initMonaco(callback) {
    if (monacoReady) { callback(); return; }

    window.require = { paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } };

    var loaderScript = document.createElement('script');
    loaderScript.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.js';
    loaderScript.onload = function () {
      window.require(['vs/editor/editor.main'], function () {
        editor = monaco.editor.create(monacoContainer, {
          value: '',
          language: 'typescript',
          theme: 'vs-dark',
          readOnly: true,
          minimap: { enabled: false },
          lineNumbers: 'on',
          stickyScroll: { enabled: true },
          scrollBeyondLastLine: false,
          folding: false,
          contextmenu: false,
          hover: { enabled: false },
          renderLineHighlight: 'none',
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          overviewRulerBorder: false,
          scrollbar: { vertical: 'auto', horizontal: 'auto' },
          automaticLayout: true,
          fontSize: 13,
          fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
          padding: { top: 8, bottom: 8 }
        });
        monacoReady = true;
        callback();
      });
    };
    document.head.appendChild(loaderScript);
  }

  function guessLanguage(filePath) {
    var ext = filePath.split('.').pop().toLowerCase();
    var map = {
      ts: 'typescript', tsx: 'typescript', vue: 'html',
      js: 'javascript', jsx: 'javascript', mjs: 'javascript',
      py: 'python',
      go: 'go',
      rs: 'rust',
      java: 'java',
      kt: 'kotlin',
      rb: 'ruby',
      cpp: 'cpp', cc: 'cpp', cxx: 'cpp', h: 'cpp', hpp: 'cpp',
      c: 'c',
      cs: 'csharp',
      swift: 'swift',
      json: 'json',
      yaml: 'yaml', yml: 'yaml',
      html: 'html',
      css: 'css',
      scss: 'scss',
      sql: 'sql',
      sh: 'shell', bash: 'shell', zsh: 'shell',
      md: 'markdown',
      xml: 'xml',
      toml: 'ini',
      dockerfile: 'dockerfile'
    };
    return map[ext] || 'plaintext';
  }

  async function showSource(nodeId) {
    if (!panel) return;
    var info = sourceMap[nodeId];
    if (!info) return;

    ensureLayout();

    headerEl.querySelector('.file-path').textContent = info.file;
    headerEl.querySelector('.line-range').textContent =
      ':' + info.startLine + '-' + info.endLine;

    var content = null;

    // Priority 1: Packed runtime (standalone mode, no local files needed)
    if (window.__codeindexSources && window.__codeindexSources[info.file]) {
      content = window.__codeindexSources[info.file];
    }

    // Priority 2: File System Access API (live mode)
    if (!content && rootDirHandle) {
      content = await readFileFromRoot(info.file);
    }

    // Priority 3: Prompt for project root if not yet selected
    if (!content && !rootDirHandle) {
      var stored = await loadHandle();
      if (stored) {
        var perm = await stored.requestPermission({ mode: 'read' });
        if (perm === 'granted') {
          rootDirHandle = stored;
        }
      }
      if (!rootDirHandle) {
        try {
          var handle = await window.showDirectoryPicker({ mode: 'read' });
          rootDirHandle = handle;
          await saveHandle(handle);
        } catch (e) {
          // User cancelled — will fall through to error below
        }
      }
      var banner = document.getElementById('codeindex-root-banner');
      if (banner) banner.remove();

      if (rootDirHandle) {
        content = await readFileFromRoot(info.file);
      }
    }

    if (!content) {
      panel.classList.add('visible');
      initMonaco(function () {
        editor.setValue('// Source not available for: ' + info.file + '\n// Run codeindex-pack to embed sources for static deployment.');
      });
      return;
    }

    panel.classList.add('visible');

    initMonaco(function () {
      var lang = guessLanguage(info.file);
      var model = editor.getModel();
      monaco.editor.setModelLanguage(model, lang);
      editor.setValue(content);

      // Set line numbers to match the actual file
      editor.updateOptions({ lineNumbers: 'on' });

      // Scroll to and highlight the relevant lines
      var startLine = info.startLine;
      var endLine = info.endLine;

      editor.revealRangeInCenter(new monaco.Range(startLine, 1, endLine, 1));

      editor.deltaDecorations(
        editor.getModel().getAllDecorations()
          .filter(function (d) { return d.options.className === 'codeindex-highlight-line'; })
          .map(function (d) { return d.id; }),
        [{
          range: new monaco.Range(startLine, 1, endLine, 1),
          options: {
            isWholeLine: true,
            className: 'codeindex-highlight-line',
            linesDecorationsClassName: 'codeindex-highlight-gutter'
          }
        }]
      );
    });
  }

  function attachClickHandlers() {
    var nodes = document.querySelectorAll('svg .node, svg .nodes .node');
    nodes.forEach(function (node) {
      var id = node.id || node.getAttribute('data-id') || '';
      var match = id.match(/^mermaid-\d+-flowchart-(.+)-(\d+)$/);
      var nodeId = null;
      if (match) {
        nodeId = match[1];
      }
      if (!nodeId) {
        match = id.match(/^flowchart-(.+)-(\d+)$/);
        nodeId = match ? match[1] : null;
      }
      if (!nodeId) {
        nodeId = id;
      }

      if (nodeId && sourceMap[nodeId]) {
        node.style.cursor = 'pointer';
        node.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          showSource(nodeId);
        });
      }
    });
  }

  function attachMermaidZoomControls() {
    var diagrams = document.querySelectorAll('.mermaid');
    diagrams.forEach(function (diagram, index) {
      if (diagram.dataset.codeindexZoomReady === 'true') return;

      var svg = diagram.querySelector('svg');
      if (!svg) return;

      diagram.dataset.codeindexZoomReady = 'true';

      var shell = document.createElement('div');
      shell.className = 'codeindex-mermaid-shell';
      diagram.parentNode.insertBefore(shell, diagram);
      shell.appendChild(diagram);

      var toolbar = document.createElement('div');
      toolbar.className = 'codeindex-mermaid-toolbar';
      toolbar.setAttribute('aria-label', 'Mermaid zoom controls');

      var zoomOut = createZoomButton('-', 'Zoom out');
      var zoomLabel = document.createElement('span');
      zoomLabel.className = 'codeindex-mermaid-zoom-label';
      zoomLabel.textContent = '100%';
      var zoomIn = createZoomButton('+', 'Zoom in');
      var reset = createZoomButton('100%', 'Reset zoom');

      toolbar.appendChild(zoomOut);
      toolbar.appendChild(zoomLabel);
      toolbar.appendChild(zoomIn);
      toolbar.appendChild(reset);
      shell.insertBefore(toolbar, diagram);

      var state = {
        scale: 1,
        min: 0.5,
        max: 2.5,
        step: 0.1,
        baseWidth: 0,
        baseHeight: 0
      };

      measureSvg(svg, state);
      applyMermaidZoom(svg, zoomLabel, state);

      zoomOut.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        state.scale = Math.max(state.min, roundScale(state.scale - state.step));
        applyMermaidZoom(svg, zoomLabel, state);
      });

      zoomIn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        state.scale = Math.min(state.max, roundScale(state.scale + state.step));
        applyMermaidZoom(svg, zoomLabel, state);
      });

      reset.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        state.scale = 1;
        applyMermaidZoom(svg, zoomLabel, state);
      });

      shell.dataset.codeindexMermaidIndex = String(index + 1);
    });
  }

  function createZoomButton(text, title) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'codeindex-mermaid-zoom-button';
    button.textContent = text;
    button.title = title;
    button.setAttribute('aria-label', title);
    return button;
  }

  function measureSvg(svg, state) {
    var rect = svg.getBoundingClientRect();
    var viewBox = svg.viewBox && svg.viewBox.baseVal;
    state.baseWidth = rect.width || (viewBox && viewBox.width) || 800;
    state.baseHeight = rect.height || (viewBox && viewBox.height) || 500;
  }

  function applyMermaidZoom(svg, label, state) {
    svg.style.width = Math.round(state.baseWidth * state.scale) + 'px';
    svg.style.height = Math.round(state.baseHeight * state.scale) + 'px';
    svg.style.maxWidth = 'none';
    label.textContent = Math.round(state.scale * 100) + '%';
  }

  function roundScale(value) {
    return Math.round(value * 10) / 10;
  }

  // -- Bootstrap --
  var hasMermaid = document.querySelectorAll('.mermaid').length > 0;

  if (hasMermaid) {
    loadMermaid();
  }

  // Only prompt for project root if runtime sources are not embedded
  if (!window.__codeindexSources && window.showDirectoryPicker) {
    restoreHandle().then(function (result) {
      if (result !== true) {
        promptForProjectRoot();
      }
    }).catch(function () {
      promptForProjectRoot();
    });
  }
})();
