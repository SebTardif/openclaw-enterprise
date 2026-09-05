import { createHttpApp } from "../index.ts";
import { configurationKey, transactionBackend } from "@openclaw-enterprise/occ";

export const start = () => ({ app: createHttpApp(), key: configurationKey(), transactionBackend });
