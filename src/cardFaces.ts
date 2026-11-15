/// <reference types="vite/client" />

// Asset URLs are public; the selected face is mounted only while a card is revealed.
const faces = import.meta.glob<string>('./assets/cards/*.svg', {
  eager: true,
  import: 'default',
  query: '?url&no-inline',
});

export function cardFace(value: string) {
  return faces[`./assets/cards/${value}.svg`];
}
