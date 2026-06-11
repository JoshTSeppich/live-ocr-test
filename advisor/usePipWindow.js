// advisor/usePipWindow.js — Document Picture-in-Picture host (contract mechanism).
//
// Opens ONE OS-level always-on-top window from a user gesture (Chrome 116+,
// verified 149 at STEP 0) on the SAME page / SAME React state. We expose a
// container <div> living inside the PiP document; the controller renders the
// panel into it with ReactDOM.createPortal, so it stays in the one React tree
// and updates with state automatically — no second app, no second process.
//
// UMD-ish: self-registers window.useAdvisorPip (a React hook).
/* global React */
(function () {
  'use strict';
  const React = (typeof window !== 'undefined' && window.React) || null;
  if (!React) return;

  const supported = typeof window !== 'undefined' && 'documentPictureInPicture' in window;

  function useAdvisorPip() {
    const [container, setContainer] = React.useState(null); // DOM node in PiP doc, or null
    const winRef = React.useRef(null);

    const close = React.useCallback(() => {
      const w = winRef.current;
      winRef.current = null;
      setContainer(null);
      if (w) { try { w.close(); } catch (e) { /* already gone */ } }
    }, []);

    const open = React.useCallback(async (opts) => {
      if (!supported) throw new Error('Document PiP unsupported in this browser');
      if (winRef.current) return winRef.current; // idempotent
      const o = opts || {};
      const pip = await window.documentPictureInPicture.requestWindow({
        width: o.width || 360, height: o.height || 200,
      });
      winRef.current = pip;
      // base document chrome — the panel itself is inline-styled, so this is minimal.
      const d = pip.document;
      d.documentElement.style.cssText = 'height:100%';
      d.body.style.cssText = 'margin:0;height:100%;background:#0b0d10;overflow:hidden';
      const host = d.createElement('div');
      host.style.cssText = 'width:100%;height:100%';
      d.body.appendChild(host);
      // when the user (or OS) closes the PiP window, drop the portal target.
      pip.addEventListener('pagehide', () => { winRef.current = null; setContainer(null); });
      setContainer(host);
      return pip;
    }, []);

    // tear down if the component unmounts while PiP is open
    React.useEffect(() => () => { if (winRef.current) { try { winRef.current.close(); } catch (e) {} } }, []);

    return { supported, isOpen: !!container, container, open, close };
  }

  if (typeof window !== 'undefined') window.useAdvisorPip = useAdvisorPip;
})();
