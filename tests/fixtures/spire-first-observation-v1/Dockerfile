# The caller must pass the reviewed digest-qualified Node base from the profile.
# A separately prepared context contains only these hash-bound inputs. No build
# step fetches dependencies or executes the acquired SPIRE/native artifacts.
ARG NODE_BASE
FROM ${NODE_BASE} AS observer
COPY --chmod=0555 observer /opt/fixture/observer
USER 1000:1000
ENTRYPOINT ["/opt/fixture/observer"]
CMD []

FROM ${NODE_BASE} AS management
COPY --chmod=0555 spire-agent /opt/fixture/spire-agent
COPY --chmod=0555 spire-server /opt/fixture/spire-server
COPY --chmod=0444 receiver-collector.mjs /opt/fixture/receiver-collector.mjs
USER 0:0
ENTRYPOINT ["node", "/opt/fixture/receiver-collector.mjs"]
CMD []

# This optional target only adds an independently accepted inert native binary.
# The first observation invokes the observer, not native model execution.
FROM observer AS observer-native
COPY --chmod=0555 native /opt/fixture/native
