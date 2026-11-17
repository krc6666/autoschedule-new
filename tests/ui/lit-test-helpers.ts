export interface LitTestElement extends HTMLElement {
  updateComplete: Promise<unknown>;
}

export async function mountElement<T extends LitTestElement>(
  tagName: string,
  properties: Record<string, unknown>
): Promise<T> {
  document.body.replaceChildren();
  const element = document.createElement(tagName) as T;
  Object.assign(element, properties);
  document.body.append(element);
  await settleLit();
  return element;
}

export async function settleLit(): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    const elements = [
      document.body,
      ...document.body.querySelectorAll("*"),
    ].filter(
      (element): element is LitTestElement => "updateComplete" in element
    );
    await Promise.all(elements.map((element) => element.updateComplete));
  }
}
