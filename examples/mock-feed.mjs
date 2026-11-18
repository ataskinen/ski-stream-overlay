// Compatibility entry point: the shared simulator with JSON Lines output.
import { createSimulator } from "../simulator/server.mjs";

const simulator = await createSimulator({
  format: "jsonl",
  tcpPort: Number(process.env.MOCK_PORT ?? 5409),
}).listen();
console.log(
  "JSON Lines test feed: 127.0.0.1:" +
    simulator.timing.address().port +
    " — controls http://127.0.0.1:" +
    simulator.web.address().port,
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await simulator.close();
    process.exit(0);
  });
