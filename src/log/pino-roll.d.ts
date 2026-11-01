// The types of the part of pino-roll that the file logger uses. The package ships none.
declare module "pino-roll" {
  /** The options of pino-roll that we pass, plus the SonicBoom options it forwards. */
  export interface RollOptions {
    /** The base path; pino-roll inserts the file number before the extension. */
    file: string;
    /** Size per file; a string takes `k`, `m` or `g`, a number is megabytes. */
    size?: string | number;
    limit?: { count?: number; removeOtherLogFiles?: boolean };
    /** Creates the directory when absent. */
    mkdir?: boolean;
    /** Writes synchronously (SonicBoom). */
    sync?: boolean;
  }

  /** The stream that pino-roll returns (a SonicBoom). */
  export interface RollStream {
    write(chunk: string): boolean;
    end(): void;
    flushSync(): void;
    /** Listens once for an event; a roll that deleted old files emits `cleanup-complete`. */
    once(event: string, listener: () => void): this;
  }

  /**
   * Opens a rolling file stream.
   *
   * @param options - the file, the size and the limits
   * @returns the stream, once the first file is open
   */
  export default function pinoRoll(options: RollOptions): Promise<RollStream>;
}
