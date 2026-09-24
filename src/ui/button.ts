export function createButton(container: HTMLElement, onToggle: (on: boolean) => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'cadastre-id-toggle';
  button.type = 'button';
  button.textContent = 'Cadastre';
  button.title = 'Créer un bâtiment depuis le cadastre (un clic par bâtiment)';
  button.style.cssText =
    'position:absolute;top:10px;right:10px;z-index:100;padding:6px 10px;' +
    'background:#fff;border:1px solid #ccc;border-radius:4px;cursor:pointer';

  let on = false;
  button.addEventListener('click', () => {
    on = !on;
    button.style.background = on ? '#2e7dd7' : '#fff';
    button.style.color = on ? '#fff' : '#333';
    onToggle(on);
  });

  container.appendChild(button);
  return button;
}
