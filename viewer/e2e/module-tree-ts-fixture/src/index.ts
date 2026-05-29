// TS module-tree fixture root. `index.ts` exists as the crate-root
// module, so this exercises the isLeaf fix: the crate root must stay a
// container (data-leaf='false') even though a real file backs it.
import { Gauge } from './widgets/gauge.ts';
import { Dial } from './widgets/dial.ts';

export class App {
  gauge: Gauge;
  dial: Dial;
  constructor(g: Gauge, d: Dial) {
    this.gauge = g;
    this.dial = d;
  }
}
