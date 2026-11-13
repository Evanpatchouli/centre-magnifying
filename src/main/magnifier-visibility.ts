// Visibility is a runtime control, independent of the saved render settings.
let visible = true

export function isMagnifierVisible(): boolean {
  return visible
}

export function rememberMagnifierVisibility(next: boolean): void {
  visible = next
}
