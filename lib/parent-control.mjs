// Only enabled for the private inherited stdin pipe of a plugin-owned Windows process.
export function attachParentControl(input, shutdown) {
  let buffer = "",
    closing = false;
  const close = () => {
    if (!closing) {
      closing = true;
      shutdown();
    }
  };
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 256) {
      buffer = "";
      return;
    }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (line === "shutdown") close();
    }
  });
  input.on("end", close);
  input.on("error", close);
}
