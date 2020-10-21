type Backlog = (worker: Worker) => void;
export class WorkerPool {
    idle: Worker[] = [];
    backlog: Backlog[] = [];
    workerAge: Map<Worker, number>;
    scriptName = 'texture_worker.js';
    maxAge = 10;
    constructor(numWorkers = 4) {
        this.workerAge = new Map();
        for (let i=0; i<numWorkers; i++) {
            const w = this.newWorker();
            this.idle.push(w);
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
        worker = this.maybeRetireWorker(worker);
        if (this.backlog.length > 0) {
            this.backlog.shift()!(worker);
        } else {
            this.idle.push(worker);
        }
    }
    private newWorker() {
        const w = new Worker(this.scriptName);
        this.workerAge.set(w, 0);
        return w;
    }
    //I seem to face ever-growing heap, so simplest strategy appears to be to terminate
    private maybeRetireWorker(worker: Worker) {
        const age = this.workerAge.get(worker)! + 1;
        if (age > this.maxAge) {
            worker.terminate();
            this.workerAge.delete(worker);
            return this.newWorker();
        }
        this.workerAge.set(worker, age);
        return worker;
    }
}

