import { Context } from "effect";
import type { Executor } from "@executor/sdk";
import type { ExecutionEngine } from "@executor/execution";
import type { Captured } from "./observability";

export class ExecutorService extends Context.Tag("ExecutorService")<
  ExecutorService,
  Captured<Executor>
>() {}

export class ExecutionEngineService extends Context.Tag("ExecutionEngineService")<
  ExecutionEngineService,
  ExecutionEngine
>() {}
