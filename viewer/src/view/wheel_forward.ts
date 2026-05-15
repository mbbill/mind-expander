// Floating panels (edge picker, arrow disambig, etc.) sit on top of
// the diagram with pointer-events: auto so the user can click their
// rows. That same setting also swallows wheel events, which means the
// canvas can't be zoomed or scrolled the moment the cursor enters the
// panel — even though the panel itself doesn't need to scroll. This
// helper re-dispatches wheel events to `#canvas-scroll` so the d3
// zoom handler picks them up as if the cursor were on the canvas.

export function forwardWheelToCanvas(el: HTMLElement): void {
  el.addEventListener(
    'wheel',
    (e) => {
      const canvas = document.querySelector<HTMLElement>('#canvas-scroll');
      if (canvas === null) return;
      e.preventDefault();
      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaZ: e.deltaZ,
          deltaMode: e.deltaMode,
          clientX: e.clientX,
          clientY: e.clientY,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { passive: false },
  );
}
