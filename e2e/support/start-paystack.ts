/** Playwright web server: the fake Paystack API used by the API's own tests. */
import { FakePaystack } from "../../api/test/fakes/paystack.js";
import { PAYSTACK_PORT } from "./env.js";

const fake = new FakePaystack();
console.log(`fake Paystack listening on ${await fake.start(PAYSTACK_PORT)}`);
