const stamp = () => new Date().toISOString();

const writeStderr = (level: "INFO" | "WARN" | "ERROR", message: string): void => {
  process.stderr.write(`[${level} ${stamp()}] ${message}\n`);
};

export const logger = {
  info(message: string): void {
    writeStderr("INFO", message);
  },
  warn(message: string): void {
    writeStderr("WARN", message);
  },
  error(message: string): void {
    writeStderr("ERROR", message);
  }
};
