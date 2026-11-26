/**
 * The hourly work of the server (instrumentation-node.ts): every task on its
 * own. A task that throws is logged and the next one still runs, so a failure
 * in the achterwacht's swap reminders never keeps the AIOS's reminders or
 * mail queue from running, and the other way round (the two diensten hold
 * each other up in nothing, docs/development/diensten.md).
 */

export interface Taak {
  /** For the log: "[naam] mislukt". */
  naam: string;
  doe: () => Promise<void> | void;
}

/** Runs the tasks one after the other, each caught on its own. Returns the names of those that failed. */
export async function draaiTaken(taken: Taak[], log: (naam: string, fout: unknown) => void = standaardLog): Promise<string[]> {
  const mislukt: string[] = [];
  for (const taak of taken) {
    try {
      await taak.doe();
    } catch (fout) {
      mislukt.push(taak.naam);
      log(taak.naam, fout);
    }
  }
  return mislukt;
}

function standaardLog(naam: string, fout: unknown): void {
  console.error(`[${naam}] mislukt`, fout);
}
