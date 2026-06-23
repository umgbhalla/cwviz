// Redirect viz.quel.computer -> the cwviz GitHub repo (path + query preserved).
// Deployed as a Cloudflare Worker with a Workers Custom Domain (provisions DNS + TLS).
export default {
  fetch(req) {
    const u = new URL(req.url);
    const dest = "https://github.com/umgbhalla/cwviz" + (u.pathname === "/" ? "" : u.pathname) + u.search;
    return Response.redirect(dest, 301);
  },
};
