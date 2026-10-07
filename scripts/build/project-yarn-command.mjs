// Yarn's Windows shim is a command script and requires cmd.exe. Keep this
// boundary limited to literal command tokens: paths and user input belong in
// cwd/environment or in a directly launched executable, not in a shell string.
export function projectYarnCommand(tokens, platform = process.platform) {
    if (
        !Array.isArray(tokens) ||
        tokens.length === 0 ||
        tokens.some(
            (token) =>
                typeof token !== "string" ||
                !/^[A-Za-z0-9_@./:=\-]+$/.test(token),
        )
    ) {
        throw new Error(
            "Project Yarn commands require literal command tokens.",
        );
    }
    return platform === "win32"
        ? {
              command: "cmd.exe",
              args: ["/d", "/s", "/c", `yarn.cmd ${tokens.join(" ")}`],
          }
        : { command: "yarn", args: [...tokens] };
}
