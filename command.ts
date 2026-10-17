/**
 * Command has no query on the spot, so it is watched: a pointer event carries the modifier by
 * itself, which is the only word on a Command that was already held before this window had the
 * focus, or released while it was elsewhere.
 */
export function trackCommand(element: HTMLElement, onHeld: (held: boolean) => void) {
  // Every key says whether Command is held, so a press this window never saw is caught by the next.
  const key = (event: KeyboardEvent) => onHeld(event.getModifierState('Meta'));
  const pointer = (event: MouseEvent) => onHeld(event.metaKey);
  const blur = () => onHeld(false);
  window.addEventListener('keydown', key);
  window.addEventListener('keyup', key);
  window.addEventListener('blur', blur);
  element.addEventListener('mousemove', pointer);
  return {
    dispose: () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('keyup', key);
      window.removeEventListener('blur', blur);
      element.removeEventListener('mousemove', pointer);
    },
  };
}