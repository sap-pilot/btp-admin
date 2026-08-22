import jakarta.servlet.*;
import jakarta.servlet.annotation.WebServlet;
import jakarta.servlet.http.*;
import com.sap.conn.jco.*;
import java.io.*;
import java.util.*;

/**
 * TomEE servlet for SAP Java Buildpack / JCo RFC connectivity test.
 *
 * Deploy with sap_java_buildpack_jakarta + USE_JCO=true and:
 *   - connectivity service bound (SCC tunnel)
 *   - destination service bound (Connectivity ApiExt reads RFC destination config)
 *   - xsuaa bound (token exchange)
 *
 * The buildpack's Connectivity ApiExt + JCoKotyoActivator manages the JCo
 * DestinationDataProvider automatically â no manual registration needed.
 * Destinations are looked up by name from the BTP Destination service.
 *
 * Endpoints:
 *   GET /         run BAPI_USER_GET_DETAIL via destination RFC_DEST_NAME env var
 *   GET /info     dump environment variables and JCo version
 *   GET /ping     health check (returns "pong")
 */
@WebServlet("/test-rfc")
public class RfcTestServlet extends HttpServlet {

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp)
            throws ServletException, IOException {
        resp.setContentType("text/plain; charset=utf-8");
        resp.setCharacterEncoding("UTF-8");

        String path = req.getPathInfo();
        if (path == null) path = "/";

        switch (path) {
            case "/ping":
                resp.getWriter().write("pong\n");
                break;
            case "/info":
                handleInfo(resp.getWriter());
                break;
            default:
                handleRfc(resp);
        }
    }

    // ââ Handlers âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

    private void handleRfc(HttpServletResponse resp) throws IOException {
        String destName = env("RFC_DEST_NAME", "API_S4_RFC_BASIC_CPIUSER");
        String username = env("RFC_USER", "R_BTP_TEST");
        PrintWriter w = resp.getWriter();
        w.println("=== RFC Test: BAPI_USER_GET_DETAIL ===");
        w.println("Destination: " + destName);
        w.println("USERNAME:    " + username);
        w.println();
        try {
            long t0 = System.currentTimeMillis();

            // Connectivity ApiExt (loaded by buildpack) resolves this destination
            // from the BTP Destination service and routes through the SCC tunnel.
            JCoDestination dest = JCoDestinationManager.getDestination(destName);
            w.println("Fetching repository...");
            JCoFunction fn = dest.getRepository().getFunction("BAPI_USER_GET_DETAIL");
            if (fn == null) { w.println("ERROR: BAPI_USER_GET_DETAIL not in repository"); return; }

            fn.getImportParameterList().setValue("USERNAME", username);
            w.println("Executing...");
            fn.execute(dest);

            w.println("SUCCESS in " + (System.currentTimeMillis() - t0) + "ms");
            w.println();
            JCoParameterList el = fn.getExportParameterList();
            if (el != null) { w.println("--- EXPORT ---"); appendRecord(w, el); }
        } catch (JCoException e) {
            resp.setStatus(500);
            w.println("FAILED (JCoException): " + e.getMessage());
        } catch (Exception e) {
            resp.setStatus(500);
            w.println("ERROR: " + e);
            e.printStackTrace(w);
        }
    }

    private void handleInfo(PrintWriter w) {
        w.println("=== SAP Java Buildpack Environment ===");
        w.println();

        w.println("--- Key env vars ---");
        String[] keys = { "JAVA_HOME", "JVM_ARGS", "USE_JCO", "TARGET_RUNTIME",
                           "JBP_CONFIG_SAPJCO", "CLASSPATH", "LD_LIBRARY_PATH", "PORT",
                           "RFC_DEST_NAME", "RFC_USER" };
        for (String k : keys) {
            String v = System.getenv(k);
            if (v != null) w.println(k + " = " + v);
        }

        w.println();
        w.println("--- All SAP/JCO/JBP env vars ---");
        System.getenv().entrySet().stream()
            .filter(e -> e.getKey().matches("(?i)(SAP|JCO|JBP|LD_LIB|CLASSPATH).*"))
            .sorted(Map.Entry.comparingByKey())
            .forEach(e -> w.println(e.getKey() + " = " + e.getValue()));

        try {
            w.println();
            w.println("--- JCo version ---");
            w.println(JCo.getVersion());
        } catch (Exception e) {
            w.println("(JCo.getVersion() failed: " + e + ")");
        }

        w.println();
        w.println("--- JCo files under /home/vcap/app/META-INF ---");
        w.println(runCommand("find", "/home/vcap/app/META-INF/.sap_java_buildpack",
                             "-name", "sapjco3*", "-o", "-name", "*connectivity*", "-o", "-name", "*jco*"));
    }

    // ââ Helpers ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

    private static void appendRecord(PrintWriter w, JCoRecord rec) {
        try {
            JCoFieldIterator it = rec.getFieldIterator();
            while (it.hasNextField()) {
                JCoField f = it.nextField();
                if (f.isStructure()) {
                    w.println(f.getName() + ":");
                    appendRecord(w, f.getStructure());
                } else if (!f.isTable()) {
                    String v = f.getString();
                    if (v != null && !v.isEmpty())
                        w.println("  " + f.getName() + " = " + v);
                }
            }
        } catch (Exception e) {
            w.println("  (error: " + e.getMessage() + ")");
        }
    }

    private static String runCommand(String... cmd) {
        try {
            Process p = Runtime.getRuntime().exec(cmd);
            StringBuilder sb = new StringBuilder();
            int n = 0;
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                String line;
                while ((line = r.readLine()) != null && n++ < 60)
                    sb.append(line).append("\n");
            }
            return sb.toString();
        } catch (Exception e) { return "(error: " + e.getMessage() + ")"; }
    }

    private static String env(String key, String def) {
        String v = System.getenv(key);
        return (v != null && !v.isEmpty()) ? v : def;
    }
}
