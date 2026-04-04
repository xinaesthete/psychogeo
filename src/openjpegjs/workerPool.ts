type Backlog = (worker: Worker) => void;
type WorkerFactory = () => Worker;
export class WorkerPool {
    idle: Worker[] = [];
    backlog: Backlog[] = [];
    workerAge: Map<Worker, number>;
    createWorker: WorkerFactory;
    maxAge = 10;
    constructor(numWorkers = 4, workerSource: string | WorkerFactory = 'texture_worker.js') {
        this.createWorker = typeof workerSource === "string"
            ? () => new Worker(workerSource)
            : workerSource;
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
    releaseWorker(worker: Worker, kill = false) {
        const nextWorker = kill ? this.terminateWorker(worker) : this.maybeRetireWorker(worker);
        if (this.backlog.length > 0) {
            this.backlog.shift()!(nextWorker);
        } else {
            this.idle.push(nextWorker);
        }
    }
    private newWorker() {
        const w = this.createWorker();
        this.workerAge.set(w, 0);
        console.log(`newWorker() : current count: ${this.workerAge.size}`);
        return w;
    }
    //I seem to face ever-growing heap, so simplest strategy appears to be to terminate
    //(or, y'know, not leak memory)
    private maybeRetireWorker(worker: Worker) {
        const age = this.workerAge.get(worker)! + 1;
        if (age > this.maxAge) {
            return this.terminateWorker(worker);
        }
        this.workerAge.set(worker, age);
        return worker;
    }
    private terminateWorker(worker: Worker) {
        worker.terminate();
        if (!this.workerAge.has(worker)) {
            throw new Error("tried to delete worker that isn't in workerAge");
        }
        if (!this.workerAge.delete(worker)) {
            console.warn(`workerAge.delete() returned false!`);
        } else {
            console.log(`workerAge.delete() ok`);
        }
        console.log(`terminateWorker() : current count: ${this.workerAge.size}`);
        return this.newWorker();
    }
}
