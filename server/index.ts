import { GameRoom } from "./GameRoom";

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

// The Worker is a thin front door:
//   - /ws  -> route the WebSocket upgrade to the single game room
//   - everything else -> serve the built client (static assets)
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      // One world == one Durable Object instance. Everyone shares it.
      const id = env.GAME_ROOM.idFromName("bamfield-world");
      const room = env.GAME_ROOM.get(id);
      return room.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

export { GameRoom };
