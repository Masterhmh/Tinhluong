export default {
  async fetch(request, env, ctx) {
    return new Response("Telegram salary bot worker is running.");
  },
};