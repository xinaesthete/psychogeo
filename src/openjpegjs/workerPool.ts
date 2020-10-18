type Backlog = (worker: Worker) => void;
export class WorkerPool {
    idle: Worker[] = [];
    backlog: Backlog[] = [];
    constructor(numWorkers = 4, scriptName = 'texture_worker.js') {
        for (let i=0; i<numWorkers; i++) {
            this.idle.push(new Worker(scriptName));
        }
    }
    async getWorker() {
        if (this.idle.length > 0) {
            return this.idle.shift()!;
        }
        const promise = new Promise<Worker>(resolve => {
            this.backlog.push(worker=>{
                resolve(worker);
            });
        });
        return promise;
    }
    releaseWorker(worker: Worker) {
        if (this.backlog.length > 0) {
            this.backlog.shift()!(worker);
        } else {
            this.idle.push(worker);
        }
    }
}

