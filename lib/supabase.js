export function createSupabaseBridgeClient({
  supabaseUrl,
  supabaseAnonKey,
  supabaseServiceRoleKey,
}) {
  function hasSupabaseConfig() {
    return Boolean(supabaseUrl && supabaseAnonKey);
  }

  function hasSupabaseAdminConfig() {
    return Boolean(supabaseUrl && supabaseServiceRoleKey);
  }

  async function supabaseRest({ path, method = "GET", token, body, prefer }) {
    if (!hasSupabaseConfig()) {
      throw new Error("Missing SUPABASE_URL/SUPABASE_ANON_KEY in bridge env");
    }
    if (!token) throw new Error("Missing user auth token");

    const headers = {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    };
    if (prefer) headers.Prefer = prefer;

    const res = await fetch(`${supabaseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    const text = await res.text().catch(() => "");
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}

    if (!res.ok) {
      throw new Error(`supabase_error:${res.status} ${text}`);
    }
    return json;
  }

  async function supabaseAdminRest({ path, method = "GET", body, prefer, token }) {
    if (!hasSupabaseAdminConfig()) {
      throw new Error("Missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY in bridge env");
    }

    const headers = {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      "Content-Type": "application/json"
    };
    if (prefer) headers.Prefer = prefer;
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${supabaseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    const text = await res.text().catch(() => "");
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}

    if (!res.ok) {
      throw new Error(`supabase_admin_error:${res.status} ${text}`);
    }
    return json;
  }

  async function getUserIdFromRequest(req) {
    const token = String(req.headers?.authorization ?? "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    if (!token) throw new Error("Missing auth token");

    const useServiceRole = hasSupabaseAdminConfig();
    const headers = {
      apikey: useServiceRole ? supabaseServiceRoleKey : supabaseAnonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    };
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      method: "GET",
      headers
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`Invalid auth token: ${text}`);
    let user = null;
    try {
      user = text ? JSON.parse(text) : null;
    } catch {}
    const userId = user?.id;
    if (!userId) throw new Error("Invalid auth token");
    return String(userId);
  }

  return {
    hasSupabaseConfig,
    hasSupabaseAdminConfig,
    supabaseRest,
    supabaseAdminRest,
    getUserIdFromRequest,
  };
}
