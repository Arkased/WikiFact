// The ten question specs, Q1 to Q10.
import { QuestionId } from "../../../domain/enums.js";
import { q1 } from "./q1.js";
import { q10 } from "./q10.js";
import { q2 } from "./q2.js";
import { q3 } from "./q3.js";
import { q4 } from "./q4.js";
import { q5 } from "./q5.js";
import { q6 } from "./q6.js";
import { q7 } from "./q7.js";
import { q8 } from "./q8.js";
import { q9 } from "./q9.js";

/** Every spec by question id. */
export const SPECS = {
  [QuestionId.Q1]: q1,
  [QuestionId.Q2]: q2,
  [QuestionId.Q3]: q3,
  [QuestionId.Q4]: q4,
  [QuestionId.Q5]: q5,
  [QuestionId.Q6]: q6,
  [QuestionId.Q7]: q7,
  [QuestionId.Q8]: q8,
  [QuestionId.Q9]: q9,
  [QuestionId.Q10]: q10,
} as const;
