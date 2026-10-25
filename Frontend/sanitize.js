function sanitize(str) {
  if (!str) return "—";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const _originalSet = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML").set;
Object.defineProperty(Element.prototype, "innerHTML", {
  set(value) {
    _originalSet.call(this, typeof value === "string"
      ? value.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
      : value
    );
  }
});