import jakarta.servlet.*;
import jakarta.servlet.annotation.WebServlet;
import jakarta.servlet.http.*;
import com.sap.conn.jco.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.spec.*;
import java.util.*;
import java.util.regex.*;
import java.util.Base64;

/**
 * Sidecar servlet for RFC testing via the SAP Java Buildpack (TomEE + JCo).
 *
 * POST /api/test-rfc — execute an RFC function by destination name
 * GET  /ping         — health check
 * GET  /info         — environment diagnostics
 *
 * btp-admin (Node.js) copies the RFC destination into the bound btp-admin-dest
 * service instance as an instance-level destination (raw jco.* properties, no
 * field-name conversion) and passes the destination name here. JCo resolves it
 * via the Kotyo provider backed by the same btp-admin-dest binding.
 *
 * Request body (JSON):
 * {
 *   "destinationName": "US10_MYSUBDOMAIN_MY_RFC_DEST_AB12CD34",
 *   "rfcName":         "STFC_CONNECTION",
 *   "importParams":    [ { "key": "REQUTEXT", "value": "hello" } ]
 * }
 *
 * Response:
 *   { "ok": true,  "durationMs": 1234, "output": { ... } }
 *   { "ok": false, "error": "...", "detail": "...", "source": "rfc|auth|config|connectivity" }
 */
@WebServlet("/*")
public class SidecarServlet extends HttpServlet {

    private volatile String    xsuaaClientId;
    private volatile PublicKey xsuaaPublicKey;

    // ─── Init ─────────────────────────────────────────────────────────────────────

    @Override
    public void init() {
        String vcap = System.getenv("VCAP_SERVICES");
        if (vcap == null) return;
        try {
            int xuIdx = vcap.indexOf("\"xsuaa\"");
            if (xuIdx < 0) return;
            int credIdx = vcap.indexOf("\"credentials\"", xuIdx);
            if (credIdx < 0) return;
            int credBrace = vcap.indexOf('{', credIdx);
            if (credBrace < 0) return;
            String creds = extractBraceBlock(vcap, credBrace);
            if (creds == null) return;
            xsuaaClientId = extractStr(creds, "clientid");
            String pem = extractStr(creds, "verificationkey");
            if (pem != null && !pem.isEmpty()) {
                xsuaaPublicKey = parsePublicKey(pem.replace("\\n", "\n").replace("\\r", ""));
                System.out.println("[Sidecar] XSUAA public key loaded, clientId=" + xsuaaClientId);
            }
        } catch (Exception e) {
            System.err.println("[Sidecar] WARNING: XSUAA init failed: " + e);
        }
    }

    // ─── Routing ─────────────────────────────────────────────────────────────────

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp)
            throws ServletException, IOException {
        resp.setContentType("text/plain; charset=utf-8");
        resp.setCharacterEncoding("UTF-8");
        String path = req.getPathInfo();
        if (path == null) path = "/";
        switch (path) {
            case "/ping": resp.getWriter().write("pong\n"); break;
            case "/info": handleInfo(req, resp.getWriter()); break;
            default:
                resp.setStatus(404);
                resp.getWriter().write("Not found\n");
        }
    }

    @Override
    protected void doPost(HttpServletRequest req, HttpServletResponse resp)
            throws ServletException, IOException {
        String path = req.getPathInfo();
        if ("/api/test-rfc".equals(path)) {
            resp.setContentType("application/json; charset=utf-8");
            resp.setCharacterEncoding("UTF-8");
            handleTestRfc(req, resp);
        } else {
            resp.setStatus(404);
            resp.setContentType("application/json; charset=utf-8");
            resp.getWriter().write("{\"ok\":false,\"error\":\"Not found\",\"source\":\"config\"}");
        }
    }

    // ─── POST /api/test-rfc ───────────────────────────────────────────────────────

    private void handleTestRfc(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        PrintWriter w = resp.getWriter();

        // Read body
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = req.getReader()) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append('\n');
        }
        String body = sb.toString();

        // JWT: prefer Authorization header, fall back to body field
        String jwtToken = null;
        String authHdr = req.getHeader("Authorization");
        if (authHdr != null && authHdr.startsWith("Bearer ")) {
            jwtToken = authHdr.substring(7).trim();
        }
        if (jwtToken == null || jwtToken.isEmpty()) {
            jwtToken = extractStr(body, "jwt");
        }

        // Validate JWT
        if (xsuaaPublicKey != null) {
            if (jwtToken == null || jwtToken.isEmpty()) {
                resp.setStatus(401);
                w.write("{\"ok\":false,\"error\":\"Missing JWT\",\"detail\":\"Bearer token required in Authorization header\",\"source\":\"auth\"}");
                return;
            }
            if (!validateJwt(jwtToken)) {
                resp.setStatus(401);
                w.write("{\"ok\":false,\"error\":\"Invalid JWT\",\"detail\":\"JWT signature verification failed or token expired\",\"source\":\"auth\"}");
                return;
            }
        }

        String destinationName = extractStr(body, "destinationName");
        if (destinationName == null || destinationName.isEmpty()) {
            resp.setStatus(400);
            w.write("{\"ok\":false,\"error\":\"Missing destinationName\",\"detail\":\"destinationName is required\",\"source\":\"config\"}");
            return;
        }

        String rfcName = extractStr(body, "rfcName");
        if (rfcName == null || rfcName.isEmpty()) {
            resp.setStatus(400);
            w.write("{\"ok\":false,\"error\":\"Missing rfcName\",\"detail\":\"rfcName is required\",\"source\":\"config\"}");
            return;
        }

        List<String[]> importParams = parseImportParams(body);

        System.out.println("[Sidecar] getDestination: " + destinationName + " rfcName: " + rfcName);

        long t0 = System.currentTimeMillis();
        try {
            JCoDestination dest = JCoDestinationManager.getDestination(destinationName);
            JCoFunction fn = dest.getRepository().getFunction(rfcName);
            if (fn == null) {
                w.write("{\"ok\":false,\"error\":\"Function not found\",\"detail\":"
                        + quoteJson(rfcName + " not found in ABAP repository")
                        + ",\"source\":\"rfc\"}");
                return;
            }

            JCoParameterList importList = fn.getImportParameterList();
            if (importList != null) {
                for (String[] kv : importParams) {
                    try { importList.setValue(kv[0], kv[1]); }
                    catch (Exception ignored) { /* skip unknown params */ }
                }
            }

            fn.execute(dest);

            long durationMs = System.currentTimeMillis() - t0;
            StringBuilder json = new StringBuilder();
            json.append("{\"ok\":true,\"durationMs\":").append(durationMs).append(",\"output\":{");
            boolean first = true;
            JCoParameterList el = fn.getExportParameterList();
            if (el != null) first = appendRecord(json, el, first);
            JCoParameterList tl = fn.getTableParameterList();
            if (tl != null) first = appendRecord(json, tl, first);
            json.append("}}");
            w.write(json.toString());

        } catch (JCoException e) {
            resp.setStatus(500);
            w.write("{\"ok\":false,\"error\":" + quoteJson(e.getMessage())
                    + ",\"detail\":\"JCoException group " + e.getGroup() + "\""
                    + ",\"source\":\"rfc\"}");
        } catch (Exception e) {
            resp.setStatus(500);
            w.write("{\"ok\":false,\"error\":" + quoteJson(e.getMessage())
                    + ",\"detail\":\"\",\"source\":\"connectivity\"}");
        }
    }

    // ─── GET /test-rfc (disabled — unauthenticated access) ───────────────────────
    //
    // Uncomment the case "/test-rfc" line in doGet() and this method to re-enable
    // for local debugging only. Never expose this in production.
    //
    // private void handleTestRfcDiag(HttpServletRequest req, PrintWriter w) {
    //     String destName = req.getParameter("dest");
    //     if (destName == null || destName.isEmpty()) destName = env("RFC_DEST_NAME", "API_S4_RFC_BASIC_CPIUSER");
    //     String rfcUser = env("RFC_USER", "");
    //     w.println("=== RFC Test (diagnostic) ===");
    //     w.println("dest     = " + destName);
    //     w.println("RFC_USER = " + rfcUser);
    //     w.println();
    //     try {
    //         long t0 = System.currentTimeMillis();
    //         JCoDestination dest = JCoDestinationManager.getDestination(destName);
    //         w.println("getDestination() OK");
    //         JCoFunction fn = dest.getRepository().getFunction("BAPI_USER_GET_DETAIL");
    //         if (fn == null) { w.println("ERROR: BAPI_USER_GET_DETAIL not found"); return; }
    //         if (!rfcUser.isEmpty()) fn.getImportParameterList().setValue("USERNAME", rfcUser);
    //         fn.execute(dest);
    //         w.println("SUCCESS in " + (System.currentTimeMillis() - t0) + "ms");
    //         JCoParameterList el = fn.getExportParameterList();
    //         if (el != null) {
    //             w.println();
    //             JCoFieldIterator it = el.getFieldIterator();
    //             while (it.hasNextField()) {
    //                 JCoField f = it.nextField();
    //                 if (!f.isStructure() && !f.isTable()) {
    //                     String v = f.getString();
    //                     if (v != null && !v.isEmpty()) w.println("  " + f.getName() + " = " + v);
    //                 }
    //             }
    //         }
    //     } catch (JCoException e) {
    //         w.println("FAILED: " + e.getMessage());
    //         w.println("Group:  " + e.getGroup());
    //     } catch (Exception e) {
    //         w.println("ERROR: " + e);
    //     }
    // }

    // ─── GET /info ────────────────────────────────────────────────────────────────

    private void handleInfo(HttpServletRequest req, PrintWriter w) {
        w.println("=== btp-admin-sidecar environment ===");
        w.println();
        String[] keys = { "JAVA_HOME", "USE_JCO", "TARGET_RUNTIME", "PORT",
                           "LD_LIBRARY_PATH", "CLASSPATH", "JBP_CONFIG_SAPJCO" };
        for (String k : keys) {
            String v = System.getenv(k);
            if (v != null) w.println(k + " = " + v);
        }
        w.println();
        w.println("XSUAA clientId = " + (xsuaaClientId != null ? xsuaaClientId : "(not loaded)"));
        w.println("XSUAA pubKey   = " + (xsuaaPublicKey != null ? "loaded" : "(not loaded)"));
        w.println();
        try {
            w.println("JCo version: " + JCo.getVersion());
        } catch (Exception e) {
            w.println("JCo.getVersion() failed: " + e);
        }

        w.println();
        w.println("=== XSUAA principal ===");
        java.security.Principal principal = req.getUserPrincipal();
        if (principal != null) {
            w.println("type  = " + principal.getClass().getName());
            w.println("name  = " + principal.getName());
        } else {
            w.println("(no principal — send Authorization: Bearer <token> to populate)");
        }

        String authHdr = req.getHeader("Authorization");
        if (authHdr != null && authHdr.startsWith("Bearer ")) {
            w.println();
            w.println("=== JWT claims ===");
            try {
                String[] parts = authHdr.substring(7).trim().split("\\.");
                if (parts.length == 3) {
                    String payload = new String(
                        Base64.getUrlDecoder().decode(addPadding(parts[1])),
                        StandardCharsets.UTF_8);
                    for (String claim : new String[]{"sub","user_name","email","zid","cid","grant_type","exp"}) {
                        String val = extractStr(payload, claim);
                        if (val != null) w.println(claim + " = " + val);
                    }
                }
            } catch (Exception e) {
                w.println("JWT parse error: " + e);
            }
        }
    }

    // ─── JSON serialization ───────────────────────────────────────────────────────

    private static boolean appendRecord(StringBuilder out, JCoRecord rec, boolean first) {
        try {
            JCoFieldIterator it = rec.getFieldIterator();
            while (it.hasNextField()) {
                JCoField f = it.nextField();
                if (!first) out.append(',');
                first = false;
                out.append(quoteJson(f.getName())).append(':');
                if (f.isStructure()) {
                    out.append('{');
                    appendRecord(out, f.getStructure(), true);
                    out.append('}');
                } else if (f.isTable()) {
                    out.append('[');
                    JCoTable tbl = f.getTable();
                    boolean firstRow = true;
                    for (int i = 0; i < tbl.getNumRows(); i++) {
                        tbl.setRow(i);
                        if (!firstRow) out.append(',');
                        firstRow = false;
                        out.append('{');
                        appendRecord(out, tbl, true);
                        out.append('}');
                    }
                    out.append(']');
                } else {
                    out.append(quoteJson(f.getString()));
                }
            }
        } catch (Exception e) {
            if (!first) out.append(',');
            out.append("\"_error\":").append(quoteJson(e.getMessage()));
        }
        return first;
    }

    private static String quoteJson(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if      (c == '"')  b.append("\\\"");
            else if (c == '\\') b.append("\\\\");
            else if (c == '\n') b.append("\\n");
            else if (c == '\r') b.append("\\r");
            else if (c == '\t') b.append("\\t");
            else if (c < 0x20)  b.append(String.format("\\u%04x", (int) c));
            else                b.append(c);
        }
        return b.append('"').toString();
    }

    // ─── JSON parsing ─────────────────────────────────────────────────────────────

    static String extractStr(String json, String key) {
        // Iterative scan — avoids Java regex NFA stack overflow on large inputs.
        String needle = "\"" + key + "\"";
        int pos = 0;
        while ((pos = json.indexOf(needle, pos)) >= 0) {
            int i = pos + needle.length();
            while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
            if (i >= json.length() || json.charAt(i) != ':') { pos++; continue; }
            i++;
            while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
            if (i >= json.length() || json.charAt(i) != '"') { pos++; continue; }
            i++; // skip opening quote
            StringBuilder sb = new StringBuilder();
            while (i < json.length()) {
                char c = json.charAt(i);
                if (c == '"') break;
                if (c == '\\' && i + 1 < json.length()) {
                    char esc = json.charAt(i + 1);
                    switch (esc) {
                        case '"':  sb.append('"');  break;
                        case '\\': sb.append('\\'); break;
                        case 'n':  sb.append('\n'); break;
                        case 'r':  sb.append('\r'); break;
                        case 't':  sb.append('\t'); break;
                        default:   sb.append(esc);  break;
                    }
                    i += 2;
                    continue;
                }
                sb.append(c);
                i++;
            }
            return sb.toString();
        }
        return null;
    }

    static String extractObject(String json, String key) {
        int keyIdx = json.indexOf("\"" + key + "\"");
        if (keyIdx < 0) return null;
        int colon = json.indexOf(':', keyIdx + key.length() + 2);
        if (colon < 0) return null;
        int start = colon + 1;
        while (start < json.length() && Character.isWhitespace(json.charAt(start))) start++;
        if (start >= json.length()) return null;
        char opener = json.charAt(start);
        if (opener != '{' && opener != '[') return null;
        return extractBraceBlock(json, start);
    }

    static String extractBraceBlock(String s, int start) {
        char opener = s.charAt(start);
        char closer = opener == '{' ? '}' : opener == '[' ? ']' : 0;
        if (closer == 0) return null;
        int depth = 0;
        boolean inStr = false;
        for (int i = start; i < s.length(); i++) {
            char c = s.charAt(i);
            if (inStr) {
                if (c == '\\') i++;
                else if (c == '"') inStr = false;
                continue;
            }
            if (c == '"') { inStr = true; continue; }
            if (c == opener) depth++;
            else if (c == closer) { if (--depth == 0) return s.substring(start, i + 1); }
        }
        return null;
    }

    static List<String[]> parseImportParams(String body) {
        List<String[]> result = new ArrayList<>();
        String arr = extractObject(body, "importParams");
        if (arr == null || arr.length() < 2) return result;
        int i = 1;
        while (i < arr.length() - 1) {
            while (i < arr.length() && arr.charAt(i) != '{') i++;
            if (i >= arr.length() - 1) break;
            String elem = extractBraceBlock(arr, i);
            if (elem == null) break;
            String k = extractStr(elem, "key");
            String v = extractStr(elem, "value");
            if (k != null && !k.isEmpty()) result.add(new String[]{ k, v != null ? v : "" });
            i += elem.length();
        }
        return result;
    }

    // ─── JWT validation ───────────────────────────────────────────────────────────

    private boolean validateJwt(String jwt) {
        try {
            String[] parts = jwt.split("\\.");
            if (parts.length != 3) return false;
            String payload = new String(Base64.getUrlDecoder().decode(addPadding(parts[1])), StandardCharsets.UTF_8);
            Pattern expPat = Pattern.compile("\"exp\"\\s*:\\s*(\\d+)");
            Matcher expM = expPat.matcher(payload);
            if (expM.find()) {
                long exp = Long.parseLong(expM.group(1));
                if (exp < System.currentTimeMillis() / 1000L) { System.err.println("[Sidecar] JWT expired"); return false; }
            }
            PublicKey pk = xsuaaPublicKey;
            if (pk != null) {
                byte[] sigBytes  = Base64.getUrlDecoder().decode(addPadding(parts[2]));
                byte[] dataBytes = (parts[0] + "." + parts[1]).getBytes(StandardCharsets.UTF_8);
                Signature sig = Signature.getInstance("SHA256withRSA");
                sig.initVerify(pk);
                sig.update(dataBytes);
                if (!sig.verify(sigBytes)) { System.err.println("[Sidecar] JWT signature invalid"); return false; }
            }
            return true;
        } catch (Exception e) {
            System.err.println("[Sidecar] JWT validation error: " + e);
            return false;
        }
    }

    private static PublicKey parsePublicKey(String pem) throws Exception {
        String keyBody = pem.replaceAll("-----[^-]+-----", "").replaceAll("\\s+", "");
        byte[] keyBytes = Base64.getDecoder().decode(keyBody);
        return KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(keyBytes));
    }

    private static String addPadding(String b64) {
        int mod = b64.length() % 4;
        if (mod == 2) return b64 + "==";
        if (mod == 3) return b64 + "=";
        return b64;
    }

    private static String env(String key, String def) {
        String v = System.getenv(key);
        return (v != null && !v.isEmpty()) ? v : def;
    }
}
