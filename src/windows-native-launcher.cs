// Development launcher. Binary stdio bridge; the application must outlive the browser's Job Object.
using System;
using System.IO;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

class HypernabNativeLauncher {
    static Dictionary<string, object> Json(string path) { return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8)); }
    static void Pump(Stream input, Stream output) {
        byte[] buffer = new byte[8192]; int read;
        while ((read = input.Read(buffer, 0, buffer.Length)) > 0) { output.Write(buffer, 0, read); output.Flush(); }
    }
    static string Quote(string value) {
        StringBuilder result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1); else result.Append('\\', slashes);
            slashes = 0; result.Append(c);
        }
        result.Append('\\', slashes * 2); return result.Append('"').ToString();
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
        public int cb; public string reserved, desktop, title; public int x,y,xSize,ySize,xCount,yCount,fill,flags; public short show, reserved2; public IntPtr reservedPtr, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public int pid, tid; }
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static int Launch(Dictionary<string, object> launcher, bool show) {
        var config = Json((string)launcher["config"]);
        string node = (string)launcher["node"], script = (string)launcher["server"];
        string desktop = launcher.ContainsKey("desktop") ? launcher["desktop"] as string : null;
        if (show && String.IsNullOrEmpty(desktop)) return 4;
        var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables()) env[(string)entry.Key] = (string)entry.Value;
        env["HYPERNAB_PORT"] = Convert.ToString(config["port"]);
        env["HYPERNAB_DATA_DIR"] = (string)config["dataDirectory"];
        env["HYPERNAB_DOWNLOAD_DIR"] = (string)config["downloadDirectory"];
        StringBuilder block = new StringBuilder(); foreach (var pair in env) block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0'); block.Append('\0');
        IntPtr memory = Marshal.StringToHGlobalUni(block.ToString());
        try {
            STARTUPINFO startup = new STARTUPINFO(); startup.cb = Marshal.SizeOf(startup); PROCESS_INFORMATION info;
            // BREAKAWAY + NEW_PROCESS_GROUP + UNICODE_ENVIRONMENT + NO_WINDOW. Never disable browser sandboxing.
            uint flags = 0x01000000 | 0x00000200 | 0x00000400 | 0x08000000;
            string executable = String.IsNullOrEmpty(desktop) ? node : desktop;
            string command = Quote(executable) + (String.IsNullOrEmpty(desktop) ? " " + Quote(script) : show ? " --native-show" : " --native-background");
            if (!CreateProcess(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false, flags, memory, Path.GetDirectoryName(script), ref startup, out info)) return 3;
            CloseHandle(info.thread); CloseHandle(info.process);
            Console.Write("{\"pid\":" + info.pid + "}"); return 0;
        } finally { Marshal.FreeHGlobal(memory); }
    }
    static int Main(string[] args) {
        try {
            var config = Json(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launcher.json"));
            if (args.Length == 1 && (args[0] == "--launch-server" || args[0] == "--show-app")) return Launch(config, args[0] == "--show-app");
            StringBuilder command = new StringBuilder(Quote((string)config["host"])).Append(" --config ").Append(Quote((string)config["config"]));
            foreach (string arg in args) command.Append(' ').Append(Quote(arg));
            ProcessStartInfo start = new ProcessStartInfo((string)config["node"], command.ToString());
            start.UseShellExecute = false; start.CreateNoWindow = true; start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
            using (Process child = Process.Start(start)) {
                Task.Factory.StartNew(() => { try { Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); child.StandardInput.Close(); } catch {} });
                Task stdout = Task.Factory.StartNew(() => { try { Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()); } catch {} });
                Task stderr = Task.Factory.StartNew(() => { try { Pump(child.StandardError.BaseStream, Console.OpenStandardError()); } catch {} });
                child.WaitForExit(); stdout.Wait(); stderr.Wait(); return child.ExitCode;
            }
        } catch { Console.Error.WriteLine("Hypernab native launcher failed."); return 2; }
    }
}
