import { useUiStore } from '@/state/ui';

export function publishFactsVisible(sequence: number, visible: boolean) {
  const state = useUiStore.getState();
  if (state.selection?.sequence === sequence && state.factsVisible !== visible)
    useUiStore.setState({ factsVisible: visible });
}
export function focusFacts(root: HTMLElement, sequence: number) {
  if (useUiStore.getState().focusRequest !== sequence) return;
  root.querySelector<HTMLHeadingElement>('h2')?.focus({ preventScroll: true });
  useUiStore.setState({ focusRequest: null });
}
