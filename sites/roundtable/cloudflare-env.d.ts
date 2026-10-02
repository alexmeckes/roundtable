declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    ROUNDTABLE_BACKEND_URL?:string;
    ROUNDTABLE_SITES_GATEWAY_SECRET?:string;
    ROUNDTABLE_SITES_ROOM?:string;
  }
}
