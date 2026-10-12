import { definePlugin } from "nitro";
import { startAlwaysOn } from "../../src/lib/always-on.server";

export default definePlugin(() => {
  startAlwaysOn();
});
