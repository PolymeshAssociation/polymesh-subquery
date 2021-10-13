import { promisify } from "util";
import { exec } from "child_process";
import { join } from "path";
const execAsync = promisify(exec);

const cwd = join(__dirname, "..");
export = async (): Promise<void> => {
  await Promise.all([
    execAsync("polymesh-local stop -c", { cwd }),
    execAsync("docker-compose down -v", { cwd }),
  ]);
};
