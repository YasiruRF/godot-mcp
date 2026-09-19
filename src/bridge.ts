/**
 * Client for the optional live bridge: a tiny WebSocket server that the
 * companion Godot EditorPlugin (see sample-project/addons/godot_mcp_bridge/)
 * opens while the Godot editor is running. When it's not running, every
 * call here fails fast with a clear message instead of hanging.
 */
import WebSocket from "ws";

const DEFAULT_URL = process.env.GODOT_MCP_BRIDGE_URL ?? "ws://127.0.0.1:9080";
const CONNECT_TIMEOUT_MS = 1500;
const REQUEST_TIMEOUT_MS = 8000;

export interface BridgeRequest {
  command: string;
  args?: Record<string, unknown>;
}

export interface BridgeResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

let idCounter = 0;

export async function callBridge(req: BridgeRequest): Promise<BridgeResponse> {
  const url = DEFAULT_URL;
  const ws = new WebSocket(url);
  const id = ++idCounter;

  return new Promise<BridgeResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(
        new Error(
          `Timed out waiting for the Godot editor bridge at ${url}. Is Godot open with the ` +
            `godot_mcp_bridge plugin enabled (Project Settings > Plugins)?`
        )
      );
    }, CONNECT_TIMEOUT_MS + REQUEST_TIMEOUT_MS);

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Could not reach the Godot editor bridge at ${url}: ${err.message}. ` +
            `Live-editor tools only work while Godot is open with the bridge plugin enabled; ` +
            `file-based tools (create_scene, write_script, etc.) don't need it.`
        )
      );
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      reject(new Error(`The Godot editor bridge at ${url} closed the connection before replying.`));
    });

    ws.on("open", () => {
      ws.send(JSON.stringify({ id, ...req }));
    });

    ws.on("message", (data) => {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(data.toString());
        ws.close();
        resolve(parsed as BridgeResponse);
      } catch (e) {
        ws.close();
        reject(new Error(`Bad response from editor bridge: ${(e as Error).message}`));
      }
    });
  });
}
