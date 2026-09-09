package nodeobserver

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type metadata struct {
	Name              string  `json:"name"`
	Namespace         string  `json:"namespace"`
	UID               string  `json:"uid"`
	ResourceVersion   string  `json:"resourceVersion"`
	DeletionTimestamp *string `json:"deletionTimestamp"`
}
type apiPod struct {
	Metadata metadata `json:"metadata"`
	Spec     struct {
		NodeName         string `json:"nodeName"`
		RuntimeClassName string `json:"runtimeClassName"`
		Containers       []struct {
			Name string `json:"name"`
		} `json:"containers"`
		InitContainers []struct {
			Name string `json:"name"`
		} `json:"initContainers"`
	} `json:"spec"`
	Status struct {
		ContainerStatuses     []containerStatus `json:"containerStatuses"`
		InitContainerStatuses []containerStatus `json:"initContainerStatuses"`
	} `json:"status"`
}
type containerStatus struct {
	Name         string `json:"name"`
	ContainerID  string `json:"containerID"`
	ImageID      string `json:"imageID"`
	RestartCount uint32 `json:"restartCount"`
}
type apiNode struct {
	Metadata metadata `json:"metadata"`
	Status   struct {
		NodeInfo struct {
			BootID string `json:"bootID"`
		} `json:"nodeInfo"`
	} `json:"status"`
}
type apiNamespace struct {
	Metadata metadata `json:"metadata"`
}

type kubeClient struct {
	client            *http.Client
	transport         *http.Transport
	base              string
	token             []byte
	caFile, tokenFile *protectedFile
}

func newKubernetes(e Enrollment) (*kubeClient, error) {
	ca, err := openProtected(e.KubernetesCAPath, false, 0)
	if err != nil {
		return nil, err
	}
	token, err := openProtected(e.KubernetesTokenPath, false, 0)
	if err != nil {
		ca.file.Close()
		return nil, err
	}
	k := &kubeClient{base: strings.TrimSuffix(e.KubernetesURL, "/"), caFile: ca, tokenFile: token}
	ok := false
	defer func() {
		if !ok {
			k.close()
		}
	}()
	roots, err := ca.bytes(256 << 10)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(roots) {
		return nil, ErrUnavailable
	}
	k.token, err = token.bytes(64 << 10)
	if err != nil {
		return nil, err
	}
	k.token = []byte(strings.TrimSpace(string(k.token)))
	if len(k.token) == 0 || strings.ContainsAny(string(k.token), " \r\n\t") {
		return nil, ErrUnavailable
	}
	k.transport = &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool}, DisableKeepAlives: true, DisableCompression: true, MaxResponseHeaderBytes: 16 << 10, TLSHandshakeTimeout: time.Second, ResponseHeaderTimeout: 2 * time.Second}
	k.client = &http.Client{Transport: k.transport, CheckRedirect: func(*http.Request, []*http.Request) error { return ErrUnavailable }}
	ok = true
	return k, nil
}
func (k *kubeClient) close() {
	if k.transport != nil {
		k.transport.CloseIdleConnections()
	}
	clear(k.token)
	if k.caFile != nil {
		k.caFile.file.Close()
	}
	if k.tokenFile != nil {
		k.tokenFile.file.Close()
	}
}
func (k *kubeClient) current() error {
	if k.caFile.current() != nil || k.tokenFile.current() != nil {
		return ErrUnavailable
	}
	return nil
}
func (k *kubeClient) read(ctx context.Context, path string, out any) error {
	if k.current() != nil {
		return ErrUnavailable
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, k.base+path, nil)
	if err != nil {
		return ErrUnavailable
	}
	req.Header.Set("Authorization", "Bearer "+string(k.token))
	req.Header.Set("Accept", "application/json")
	response, err := k.client.Do(req)
	if err != nil {
		return ErrUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return ErrUnavailable
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4<<20+1))
	if err != nil || len(raw) > 4<<20 || json.Unmarshal(raw, out) != nil || k.current() != nil {
		return ErrUnavailable
	}
	return nil
}
func (k *kubeClient) objects(ctx context.Context, e Enrollment, r Request, boot string) (apiNode, apiNamespace, apiPod, error) {
	var n apiNode
	var ns apiNamespace
	var p apiPod
	if k.read(ctx, "/api/v1/nodes/"+url.PathEscape(e.NodeName), &n) != nil || n.Metadata.UID != e.NodeUID || n.Metadata.Name != e.NodeName || n.Metadata.ResourceVersion == "" || n.Metadata.DeletionTimestamp != nil || n.Status.NodeInfo.BootID != boot {
		return n, ns, p, ErrUnavailable
	}
	if k.read(ctx, "/api/v1/namespaces/"+url.PathEscape(e.Namespace), &ns) != nil || ns.Metadata.Name != e.Namespace || ns.Metadata.UID == "" || ns.Metadata.DeletionTimestamp != nil {
		return n, ns, p, ErrUnavailable
	}
	if k.read(ctx, "/api/v1/namespaces/"+url.PathEscape(e.Namespace)+"/pods/"+url.PathEscape(r.PodName), &p) != nil || p.Metadata.UID != r.PodUID || p.Metadata.Name != r.PodName || p.Metadata.Namespace != e.Namespace || p.Metadata.ResourceVersion == "" || p.Metadata.DeletionTimestamp != nil || p.Spec.NodeName != e.NodeName || p.Spec.RuntimeClassName != "oce-gvisor-systrap" {
		return n, ns, p, ErrUnavailable
	}
	return n, ns, p, nil
}
