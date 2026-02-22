const stamp = () => new Date().toISOString();

export const logger = {
  info(message: string): void {
    console.log(`[INFO ${stamp()}] ${message}`);
  },
  warn(message: string): void {
    console.warn(`[WARN ${stamp()}] ${message}`);
  },
  error(message: string): void {
    console.error(`[ERROR ${stamp()}] ${message}`);
  }
};
