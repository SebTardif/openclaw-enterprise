import test from "node:test";
import { installedRepositoryJourney } from "../helpers/repository-credentials-installed-journey.mjs";

test(
  "installed dedicated read-only Agent fetches and is denied a repository push",
  {
    skip:
      process.env.OCC_TEST_REPOSITORY_CREDENTIALS_REAL === "1"
        ? false
        : "Set OCC_TEST_REPOSITORY_CREDENTIALS_REAL=1 with explicit authorized repository, protected App inputs, model key and immutable images.",
    timeout: 1800000,
  },
  installedRepositoryJourney("dedicated", "git-read"),
);
