// Integration-test fixture for the TypeScript frontend. Exercises every
// mapping the frontend cares about: interface + interface-extends, class
// + class-extends + implements, type alias, enum, top-level fn, and the
// cardinality cases (one / optional / many / many-keyed).

export interface Handler {
  handle(req: Request): Response;
}

export interface AdminHandler extends Handler {
  audit(): void;
}

export type RequestId = string;

export enum Method {
  Get,
  Post,
  Put,
  Delete,
}

export class Request {
  id: RequestId;
  method: Method;
  // many-keyed: Map<K, V>
  headers: Map<string, string>;
  // optional: '?' modifier
  body?: string;

  constructor(id: RequestId, method: Method) {
    this.id = id;
    this.method = method;
    this.headers = new Map();
  }
}

export class Response {
  status: number;
  body: string;
}

export class Server implements Handler {
  // many: T[]
  routes: Route[];
  // many: Set<T> — container itself filtered from edges as a builtin,
  // edge synthesised to the inner type with cardinality=many.
  active: Set<Request>;

  handle(req: Request): Response {
    return new Response();
  }
}

export class AuthServer extends Server implements AdminHandler {
  audit(): void {}
}

export class Route {
  pattern: string;
  // one: plain ref
  handler: Handler;
}

export function makeServer(): Server {
  return new Server();
}
