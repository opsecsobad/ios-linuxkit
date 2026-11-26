/**
 * xterm-term-bridge.js — xterm.js terminal bridge for ios-linuxkit.
 *
 * Drop-in alternative to term.js (Ghostty). Uses the same native bridge API
 * (window.exports / webkit.messageHandlers) so the Obj-C host code doesn't
 * need changes — only the HTML entry point differs (xterm-term.html vs term.html).
 *
 * Build switch: in Terminal.m, load xterm-term.html instead of term.html to use
 * the xterm.js renderer instead of Ghostty WebGL/Canvas2D.
 */

(async () => {
    'use strict';

    window.exports = {
        write() {},
        getSize: () => [0, 0],
        copy: () => false,
        setFocused() {},
        scrollToBottom() {},
        newScrollTop() {},
        updateStyle() {},
        getCharacterSize: () => [0, 0],
        clearScrollback() {},
        setUserGesture() {},
        setAccessibilityEnabled() {},
    };

    const terminalElement = document.getElementById('terminal');
    const { Terminal, FitAddon, WebLinksAddon, LigaturesAddon } = window.xtermModules || {};
    const { CanvasAddon } = window.CanvasAddon || {};
    if (!Terminal || !FitAddon || !WebLinksAddon || !LigaturesAddon) {
        window.__terminalBootstrapLog?.('terminal xterm modules were not loaded');
        return;
    }
    if (!CanvasAddon) {
        window.__terminalBootstrapLog?.('terminal xterm canvas addon was not loaded');
        return;
    }

    const ansiColorNames = [
        'black',
        'red',
        'green',
        'yellow',
        'blue',
        'magenta',
        'cyan',
        'white',
        'brightBlack',
        'brightRed',
        'brightGreen',
        'brightYellow',
        'brightBlue',
        'brightMagenta',
        'brightCyan',
        'brightWhite',
    ];

    // ── Native bridge (same as term.js) ──────────────────────────────────────
    const native = new Proxy({}, {
        get(_, prop) {
            return (...args) => {
                if (!window.webkit?.messageHandlers?.[prop])
                    return;
                let body = null;
                if (args.length == 1)
                    body = args[0];
                else if (args.length > 1)
                    body = args;
                window.webkit.messageHandlers[prop].postMessage(body);
            };
        }
    });

    // ── Style state ──────────────────────────────────────────────────────────
    let styleState = {
        foregroundColor: '#d4d4d4',
        backgroundColor: '#1e1e1e',
        cursorColor: undefined,
        fontSize: 12,
        fontFamily: '"JetBrainsMono Nerd Font Mono", "FiraCode Nerd Font Mono", ui-monospace, "SFMono-Regular", Menlo, Monaco, monospace',
        colorPaletteOverrides: undefined,
        blinkCursor: false,
        cursorShape: 'BLOCK',
    };
    styleState = {...styleState, ...normalizeStyleUpdate(window.__terminalInitialStyle)};
    applyDocumentStyle(styleState);
    await loadConfiguredFont(styleState);

    let resizeFrame = null;
    let pendingScrollSync = false;
    let lastNativeScrollHeight;
    let lastNativeScrollTop;
    let nativeScrollRequest = null;
    let oldProps = {};
    let xtermAppActive = null;
    // iOS-style selection: inclusive linear cell indices (row * cols + col).
    let selectionAnchor = null;   // {start, end} of the long-pressed word
    let selStart = null;
    let selEnd = null;
    let handleDrag = null;        // 'start' | 'end' while a handle is dragged
    let gestureOnHandle = false;  // native long-press began on a handle
    let selectionHandles = null;  // created lazily (DOM + CSS)
    let selectionGeneration = 0;  // bumped by each long-press selection

    // ── Terminal setup ────────────────────────────────────────────────────────
    const term = new Terminal({
        cols: 80,
        rows: 24,
        fontSize: styleState.fontSize,
        fontFamily: styleState.fontFamily,
        theme: {
            foreground: styleState.foregroundColor,
            background: styleState.backgroundColor,
            cursor: styleState.cursorColor || styleState.foregroundColor,
            cursorAccent: styleState.backgroundColor,
        },
        cursorBlink: styleState.blinkCursor,
        cursorStyle: cursorStyleForXterm(styleState.cursorShape),
        allowTransparency: true,
        scrollback: 10000,
        convertEol: false,
        disableStdin: true,  // iOS handles text input natively
        allowProposedApi: true,
        overviewRuler: {width: 0},
        smoothScrollDuration: 0,
        windowsMode: false,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(new CanvasAddon());
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    // OSC 8 hyperlinks: open the real target, not the (possibly shortened or
    // wrapped) visible text. Claude Code's login link relies on this.
    term.options.linkHandler = {
        activate(event, uri) {
            if (/^https?:\/\//i.test(uri))
                native.openLink(uri);
        },
        allowNonHttpProtocols: false,
    };

    // OSC 52 clipboard writes ("\e]52;c;<base64>\a") -> iOS pasteboard.
    // Reads ("?") are refused so guest programs cannot snoop the clipboard.
    term.parser.registerOscHandler(52, (data) => {
        const separator = data.indexOf(';');
        if (separator < 0)
            return false;
        const payload = data.slice(separator + 1);
        if (payload === '?' || payload === '')
            return true;
        try {
            const binary = atob(payload);
            const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
            native.copyText(new TextDecoder().decode(bytes));
        } catch (error) {
            native.log(`OSC 52 decode failed: ${error}`);
        }
        return true;
    });

    term.onData((data) => {
        native.sendInput(data);
        syncApplicationCursor();
    });
    term.onResize(() => {
        native.resize();
        scheduleScrollSync();
    });
    term.onScroll(scheduleScrollSync);
    term.onCursorMove(syncApplicationCursor);
    term.onSelectionChange(() => {
        native.selectionChanged(term.getSelection());
        if (!term.hasSelection())
            selStart = selEnd = null;
        positionSelectionHandles();
    });
    term.onScroll(() => positionSelectionHandles());
    term.onResize(() => positionSelectionHandles());

    term.open(terminalElement);
    installNativeFocusAdapter();
    installLigatures();
    disableWebTextInput();
    installFocusBridge();
    fitAddon.fit();
    syncApplicationCursor();
    scheduleScrollSync();

    // ── Resize handling ──────────────────────────────────────────────────────
    function fitTerminal() {
        if (resizeFrame !== null)
            return;
        resizeFrame = requestAnimationFrame(() => {
            resizeFrame = null;
            fitAddon.fit();
            native.resize();
            scheduleScrollSync();
        });
    }

    const ro = new ResizeObserver(() => fitTerminal());
    ro.observe(terminalElement);

    // ── Exports (native → JS) ────────────────────────────────────────────────
    function latin1StringToBytes(str) {
        const bytes = new Uint8Array(str.length);
        for (let i = 0; i < str.length; i++) {
            bytes[i] = str.charCodeAt(i) & 0xff;
        }
        return bytes;
    }

    window.exports = {
        write(data) {
            const bytes = typeof data === 'string' ? latin1StringToBytes(data) : new Uint8Array(data);
            term.write(bytes, scheduleScrollSync);
            if (bytes.includes(0x1b))
                syncApplicationCursor();
        },
        getSize() {
            return [term.cols, term.rows];
        },
        copy() {
            return term.getSelection();
        },
        // Native long-press began: select the word under the finger.
        beginSelection(x, y) {
            gestureOnHandle = handleDrag !== null || isOnSelectionHandle(x, y);
            if (gestureOnHandle)
                return 'handle';
            const cell = selectionCell(x, y);
            if (!cell)
                return;
            const [start, end] = wordBounds(cell);
            selectionGeneration++;
            selectionAnchor = {start, end};
            selStart = start;
            selEnd = end;
            applySelection();
        },
        // Long-press drag: grow the selection from the word toward the finger.
        extendSelection(x, y) {
            if (gestureOnHandle || handleDrag !== null || !selectionAnchor)
                return;
            const cell = selectionCell(x, y);
            if (!cell)
                return;
            const p = linearCell(cell);
            if (p >= selectionAnchor.start) {
                selStart = selectionAnchor.start;
                selEnd = Math.max(p, selectionAnchor.end);
            } else {
                selStart = p;
                selEnd = selectionAnchor.end;
            }
            applySelection();
        },
        selectAll() { term.selectAll(); },
        // Whole buffer (scrollback + screen) as text; soft-wrapped rows joined.
        getAllText() {
            const buffer = term.buffer.active;
            const lines = [];
            for (let i = 0; i < buffer.length; i++) {
                const line = buffer.getLine(i);
                if (!line)
                    continue;
                const text = line.translateToString(true);
                if (line.isWrapped && lines.length)
                    lines[lines.length - 1] += text;
                else
                    lines.push(text);
            }
            while (lines.length && lines[lines.length - 1] === '')
                lines.pop();
            return lines.join('\n');
        },
        clearSelection() { clearTermSelection(); },
        setFocused(focused) {
            terminalElement.classList.toggle('terminal-focused', !!focused);
            setXtermAppActive(!!focused);
        },
        scrollToBottom() {
            term.scrollToBottom();
            scheduleScrollSync();
        },
        newScrollTop(top) {
            if (!Number.isFinite(top))
                return;
            const cellHeight = getCellSize().height;
            if (!cellHeight)
                return;
            const buffer = term.buffer.active;
            const line = Math.max(0, Math.min(buffer.baseY, Math.round(top / cellHeight)));
            // UIKit owns fractional offsets and momentum. Do not snap its
            // offset back to the rounded row when acknowledging this request.
            nativeScrollRequest = {buffer, line, cellHeight};
            term.scrollToLine(line);
            scheduleScrollSync();
        },
        async updateStyle(newStyle) {
            styleState = {...styleState, ...normalizeStyleUpdate(newStyle)};
            applyDocumentStyle(styleState);
            await loadConfiguredFont(styleState);

            if (term.options.fontSize !== styleState.fontSize)
                term.options.fontSize = styleState.fontSize;
            if (term.options.fontFamily !== styleState.fontFamily)
                term.options.fontFamily = styleState.fontFamily;
            term.options.cursorBlink = !!styleState.blinkCursor;
            term.options.cursorStyle = cursorStyleForXterm(styleState.cursorShape);
            term.options.theme = themeForXterm(styleState);

            fitTerminal();
            term.refresh(0, term.rows - 1);
            scheduleScrollSync();
        },
        getCharacterSize() {
            const size = getCellSize();
            return [size.width || 0, size.height || 0];
        },
        clearScrollback() {
            term.clear();
            term.scrollToBottom();
            scheduleScrollSync();
        },
        setUserGesture() {},
        setAccessibilityEnabled() {},
    };

    // ── Signal ready ─────────────────────────────────────────────────────────
    setXtermAppActive(true);
    fitTerminal();
    native.load();
    native.syncFocus();

    function disableWebTextInput() {
        if (!term.textarea)
            return;
        term.textarea.readOnly = true;
        term.textarea.tabIndex = -1;
        term.textarea.autocapitalize = 'off';
        term.textarea.autocomplete = 'off';
        term.textarea.autocorrect = 'off';
        term.textarea.spellcheck = false;
    }

    function selectionCell(x, y) {
        const screen = terminalElement.querySelector('.xterm-screen');
        const cell = getCellSize();
        if (!screen || !cell.width || !cell.height || !Number.isFinite(x) || !Number.isFinite(y))
            return null;
        const rect = screen.getBoundingClientRect();
        return {
            col: Math.max(0, Math.min(term.cols - 1, Math.floor((x - rect.left) / cell.width))),
            row: term.buffer.active.viewportY + Math.max(0, Math.min(term.rows - 1, Math.floor((y - rect.top) / cell.height))),
        };
    }

    // ── iOS-style selection handles ───────────────────────────────────────────
    function linearCell(cell) {
        return cell.row * term.cols + cell.col;
    }

    function applySelection() {
        if (selStart === null || selEnd === null)
            return;
        const a = Math.min(selStart, selEnd);
        const b = Math.max(selStart, selEnd);
        term.select(a % term.cols, Math.floor(a / term.cols), b - a + 1);
    }

    function clearTermSelection() {
        selectionAnchor = null;
        selStart = selEnd = null;
        handleDrag = null;
        term.clearSelection();
        positionSelectionHandles();
    }

    // Whitespace-delimited token, so paths/URLs/flags select in one go.
    function wordBounds(cell) {
        const line = term.buffer.active.getLine(cell.row);
        const at = (col) => line?.getCell(col)?.getChars() || '';
        const isWord = (col) => /\S/.test(at(col));
        const here = linearCell(cell);
        if (!isWord(cell.col))
            return [here, here];
        let s = cell.col;
        let e = cell.col;
        while (s > 0 && isWord(s - 1))
            s--;
        while (e < term.cols - 1 && (isWord(e + 1) || at(e + 1) === ''))
            e++;
        while (e > s && !isWord(e))
            e--;
        return [cell.row * term.cols + s, cell.row * term.cols + e];
    }

    function createSelectionHandles() {
        const style = document.createElement('style');
        style.textContent = `
            .sel-handle { position: fixed; width: 44px; margin-left: -22px; z-index: 1000;
                          touch-action: none; -webkit-user-select: none; display: none; }
            .sel-knob { position: absolute; left: 16px; width: 12px; height: 12px;
                        border-radius: 6px; background: #0a84ff; }
            .sel-bar { position: absolute; left: 21px; width: 2px; background: #0a84ff; }`;
        document.head.appendChild(style);
        const make = (kind) => {
            const el = document.createElement('div');
            el.className = `sel-handle sel-handle-${kind}`;
            el.innerHTML = '<div class="sel-knob"></div><div class="sel-bar"></div>';
            document.body.appendChild(el);
            el.addEventListener('touchstart', (event) => {
                event.preventDefault();
                event.stopPropagation();
                handleDrag = kind;
                native.hideMenu();
            }, {passive: false});
            el.addEventListener('touchmove', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (handleDrag !== kind || !event.touches.length)
                    return;
                moveSelectionHandle(kind, event.touches[0].clientX, event.touches[0].clientY);
            }, {passive: false});
            const finish = (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (handleDrag !== kind)
                    return;
                handleDrag = null;
                showMenuForSelection();
            };
            el.addEventListener('touchend', finish, {passive: false});
            el.addEventListener('touchcancel', finish, {passive: false});
            return el;
        };
        return {start: make('start'), end: make('end')};
    }

    function isOnSelectionHandle(x, y) {
        const el = document.elementFromPoint(x, y);
        return !!el?.closest?.('.sel-handle');
    }

    function moveSelectionHandle(kind, x, y) {
        if (selStart === null || selEnd === null)
            return;
        const cellHeight = getCellSize().height || 16;
        // The knob sits above (start) / below (end) the text; aim at the text row.
        const cell = selectionCell(x, kind === 'start' ? y + cellHeight * 0.9 : y - cellHeight * 0.9);
        if (!cell)
            return;
        const p = linearCell(cell);
        const lo = Math.min(selStart, selEnd);
        const hi = Math.max(selStart, selEnd);
        if (kind === 'start') {
            selStart = Math.min(p, hi);
            selEnd = hi;
        } else {
            selStart = lo;
            selEnd = Math.max(p, lo);
        }
        applySelection();
    }

    function selectionEdgeRect(index, trailing) {
        const screen = terminalElement.querySelector('.xterm-screen');
        const cell = getCellSize();
        if (!screen || !cell.width || !cell.height)
            return null;
        const rect = screen.getBoundingClientRect();
        const row = Math.floor(index / term.cols) - term.buffer.active.viewportY;
        if (row < 0 || row >= term.rows)
            return null;
        const col = (index % term.cols) + (trailing ? 1 : 0);
        return {x: rect.left + col * cell.width, y: rect.top + row * cell.height, height: cell.height};
    }

    function positionSelectionHandles() {
        if (!selectionHandles) {
            if (!document.body)
                return;
            selectionHandles = createSelectionHandles();
        }
        const show = term.hasSelection() && selStart !== null && selEnd !== null;
        const place = (el, edge, kind) => {
            if (!show || !edge) {
                el.style.display = 'none';
                return;
            }
            const knob = el.firstChild;
            const bar = el.lastChild;
            el.style.display = 'block';
            // Keep knobs on screen at column 0 / the last column.
            el.style.left = `${Math.max(7, Math.min(window.innerWidth - 7, edge.x))}px`;
            el.style.height = `${edge.height + 12}px`;
            if (kind === 'start') {
                el.style.top = `${edge.y - 12}px`;
                knob.style.top = '0px';
                bar.style.top = '10px';
            } else {
                el.style.top = `${edge.y}px`;
                bar.style.top = '0px';
                knob.style.top = `${edge.height - 1}px`;
            }
            bar.style.height = `${edge.height + 2}px`;
        };
        const lo = show ? Math.min(selStart, selEnd) : 0;
        const hi = show ? Math.max(selStart, selEnd) : 0;
        place(selectionHandles.start, show && selectionEdgeRect(lo, false), 'start');
        place(selectionHandles.end, show && selectionEdgeRect(hi, true), 'end');
    }

    function showMenuForSelection() {
        if (selStart === null || selEnd === null)
            return;
        const edge = selectionEdgeRect(Math.max(selStart, selEnd), true)
            || selectionEdgeRect(Math.min(selStart, selEnd), false);
        if (edge)
            native.showMenu([edge.x, edge.y + edge.height]);
    }

    // Full-screen apps (Claude Code, vim, less, htop, tmux) draw on the
    // alternate screen and/or enable mouse reporting, so there is no xterm
    // scrollback to move. Hand swipes to them as mouse-wheel events instead;
    // xterm.js encodes those as mouse reports or arrow keys as appropriate.
    function appHandlesScrolling() {
        return term.buffer.active.type === 'alternate' ||
            (term.modes?.mouseTrackingMode && term.modes.mouseTrackingMode !== 'none');
    }

    function sendWheel(lines, x, y, cellHeight) {
        const target = term.element?.querySelector('.xterm-screen') || term.element;
        if (!target)
            return;
        // Keyboard input reaches the guest natively, so the bridge runs xterm
        // with disableStdin, which also drops the wheel reports xterm encodes.
        // Lift it just while dispatching; one line-mode event per line.
        const stdinWasDisabled = term.options.disableStdin;
        term.options.disableStdin = false;
        try {
            for (let i = 0; i < Math.abs(lines); i++) {
                target.dispatchEvent(new WheelEvent('wheel', {
                    deltaY: Math.sign(lines),
                    deltaMode: WheelEvent.DOM_DELTA_LINE,
                    clientX: x,
                    clientY: y,
                    bubbles: true,
                    cancelable: true,
                }));
            }
        } finally {
            term.options.disableStdin = stdinWasDisabled;
        }
    }

    function installFocusBridge() {
        // touchstart is cancelled (to keep WebKit from selecting/zooming),
        // which also stops UIKit's pan from scrolling the native scroll view.
        // Scroll the scrollback from the touch stream ourselves instead.
        let touchScroll = null;
        terminalElement.addEventListener('touchstart', (event) => {
            touchScroll = event.touches.length === 1
                ? {y: event.touches[0].clientY, acc: 0, moved: false,
                   hadSelection: term.hasSelection(), generation: selectionGeneration}
                : null;
            if (!term.hasSelection())
                event.preventDefault();
        }, {capture: true});
        terminalElement.addEventListener('touchmove', (event) => {
            if (!touchScroll || event.touches.length !== 1 || term.hasSelection())
                return;
            const y = event.touches[0].clientY;
            const cellHeight = getCellSize().height || 16;
            touchScroll.acc += touchScroll.y - y;
            touchScroll.y = y;
            const lines = Math.trunc(touchScroll.acc / cellHeight);
            if (lines !== 0) {
                touchScroll.acc -= lines * cellHeight;
                touchScroll.moved = true;
                if (appHandlesScrolling())
                    sendWheel(lines, event.touches[0].clientX, y, cellHeight);
                else {
                    term.scrollLines(lines);
                    scheduleScrollSync();
                }
            }
            event.preventDefault();
        }, {capture: true, passive: false});
        terminalElement.addEventListener('touchend', (event) => {
            const scrolled = touchScroll?.moved;
            // A tap dismisses a selection that existed before it. A selection
            // made during this touch (long-press) must survive the finger lift,
            // or the Copy menu has nothing to copy.
            const dismissSelection = touchScroll?.hadSelection &&
                touchScroll.generation === selectionGeneration;
            touchScroll = null;
            if (dismissSelection && term.hasSelection())
                clearTermSelection();
            event.preventDefault();
            event.stopImmediatePropagation();
            if (!scrolled)
                native.focus();
        }, {capture: true});
        terminalElement.addEventListener('mousedown', (event) => {
            event.preventDefault();
            if (!term.hasSelection())
                native.focus();
        }, {capture: true});
        terminalElement.addEventListener('focus', () => native.syncFocus());
        terminalElement.addEventListener('blur', () => native.syncFocus());
    }

    function installLigatures() {
        try {
            term.loadAddon(new LigaturesAddon());
        } catch (error) {
            native.log(`terminal ligatures addon failed: ${error?.stack || error}`);
        }
    }

    function installNativeFocusAdapter() {
        const browserService = term._core?._coreBrowserService;
        if (!browserService)
            return;
        try {
            Object.defineProperty(browserService, 'isFocused', {
                configurable: true,
                get: () => !!xtermAppActive,
            });
        } catch (error) {
            native.log(`terminal focus adapter failed: ${error?.stack || error}`);
        }
    }

    function setXtermAppActive(active) {
        if (xtermAppActive === active) {
            if (active)
                ensureCursorVisible();
            return;
        }
        xtermAppActive = active;

        const core = term._core;
        try {
            if (core?.element)
                core.element.classList.toggle('focus', active);
            if (active) {
                core?._renderService?.handleFocus?.();
                ensureCursorVisible();
            } else {
                core?._renderService?.handleBlur?.();
            }
        } catch (error) {
            native.log(`terminal focus sync failed: ${error?.stack || error}`);
        }
    }

    function ensureCursorVisible() {
        const coreService = term._core?.coreService;
        if (coreService)
            coreService.isCursorInitialized = true;
        term.refresh(term.buffer.active.cursorY, term.buffer.active.cursorY);
    }

    function scheduleScrollSync() {
        if (pendingScrollSync)
            return;
        pendingScrollSync = true;
        requestAnimationFrame(() => {
            pendingScrollSync = false;
            syncScroll();
        });
    }

    function syncScroll() {
        const cellHeight = getCellSize().height;
        if (!cellHeight)
            return;
        const buffer = term.buffer.active;
        // Fit rounds rows down; the unused fraction still belongs to UIKit's
        // viewport. Its maximum offset must equal baseY * cellHeight exactly.
        const scrollHeight = buffer.baseY * cellHeight + terminalElement.clientHeight;
        const scrollTop = buffer.viewportY * cellHeight;

        if (scrollHeight !== lastNativeScrollHeight) {
            native.newScrollHeight(scrollHeight);
            lastNativeScrollHeight = scrollHeight;
        }
        const acknowledgesNativeScroll = nativeScrollRequest?.buffer === buffer &&
            nativeScrollRequest.line === buffer.viewportY &&
            nativeScrollRequest.cellHeight === cellHeight;
        nativeScrollRequest = null;
        if (!acknowledgesNativeScroll && scrollTop !== lastNativeScrollTop) {
            native.newScrollTop(scrollTop);
        }
        lastNativeScrollTop = scrollTop;
    }

    function syncApplicationCursor() {
        syncProp('applicationCursor', !!term.modes?.applicationCursorKeysMode);
    }

    function syncProp(name, value) {
        if (oldProps[name] !== value)
            native.propUpdate(name, value);
        oldProps[name] = value;
    }

    function getCellSize() {
        const dims = term._core?._renderService?.dimensions;
        return {
            width: dims?.css?.cell?.width || 0,
            height: dims?.css?.cell?.height || 0,
        };
    }

    function normalizeStyleUpdate(nextStyle) {
        const style = {...(nextStyle || {})};
        if (!Array.isArray(style.colorPaletteOverrides))
            style.colorPaletteOverrides = undefined;
        return style;
    }

    function applyDocumentStyle(style) {
        if (style.backgroundColor)
            document.documentElement.style.setProperty('--terminal-background', style.backgroundColor);
        if (style.foregroundColor)
            document.documentElement.style.setProperty('--terminal-foreground', style.foregroundColor);
    }

    async function loadConfiguredFont(style) {
        if (!document.fonts?.load)
            return;
        const family = firstFontFamily(style.fontFamily);
        if (!family)
            return;
        try {
            await Promise.all([
                document.fonts.load(`${style.fontSize}px ${quoteCssFontFamily(family)}`),
                document.fonts.load(`700 ${style.fontSize}px ${quoteCssFontFamily(family)}`),
            ]);
            await document.fonts.ready;
        } catch (error) {
            native.log(`terminal font load failed: ${error}`);
        }
    }

    function firstFontFamily(familyList) {
        const trimmed = String(familyList || '').trim();
        if (!trimmed)
            return '';
        const match = trimmed.match(/^(['"])(.*?)\1/);
        if (match)
            return match[2];
        return trimmed.split(',')[0].trim();
    }

    function quoteCssFontFamily(family) {
        const trimmed = String(family || '').trim();
        if (!trimmed || trimmed.startsWith('"') || trimmed.startsWith("'"))
            return trimmed;
        if (/^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(trimmed))
            return trimmed;
        return `"${trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }

    function cursorStyleForXterm(cursorShape) {
        switch (cursorShape) {
            case 'BEAM':
            case 'bar':
                return 'bar';
            case 'UNDERLINE':
            case 'underline':
                return 'underline';
            case 'BLOCK':
            case 'block':
            default:
                return 'block';
        }
    }

    function themeForXterm(style) {
        const theme = {
            foreground: style.foregroundColor,
            background: style.backgroundColor,
            cursor: style.cursorColor || style.foregroundColor,
            cursorAccent: style.backgroundColor,
            selectionBackground: 'rgba(10, 132, 255, 0.40)',
        };
        if (Array.isArray(style.colorPaletteOverrides)) {
            for (let i = 0; i < Math.min(ansiColorNames.length, style.colorPaletteOverrides.length); i++)
                theme[ansiColorNames[i]] = style.colorPaletteOverrides[i];
        }
        return theme;
    }

})();
