/** Whether keyboard focus is in a text field, where keys type instead of acting as shortcuts. */
export const typingInField = () => {
  const el = document.activeElement;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
};
