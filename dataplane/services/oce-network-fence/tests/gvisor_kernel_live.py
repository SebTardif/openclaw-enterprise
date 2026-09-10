#!/usr/bin/env python3
"""Actual runsc/veth closed-fence proof in one disposable network-none container.

Select the image, runtime and fence digests outside this fixture. Mount only
these tools and this file read-only; never mount host namespaces or Docker's
socket. The outer container supplies the CPU/memory/PID limits. No CRI, Work,
identity, start-barrier or positive endpoint-opening qualification is implied.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import socket
import subprocess
import sys
import sysconfig
import threading
import time


GUEST = r'''
import json,os,socket,sys,threading
received=[]

def exchange(connection, message):
 connection.settimeout(1)
 connection.sendall(message)
 response=b''
 while len(response)<len(message):
  part=connection.recv(len(message)-len(response))
  if not part: return False
  response+=part
 return response==message

def accepted(connection):
 try:
  with connection:
   while True:
    message=connection.recv(256)
    if not message: return
    if sum(map(len,received))+len(message)>8192: raise RuntimeError('receiver log bound')
    received.append(message.decode('ascii'))
    connection.sendall(message)
 except OSError: pass

def tcp_server(server):
 while True:
  connection,_=server.accept()
  threading.Thread(target=accepted,args=(connection,),daemon=True).start()

def udp_server(server):
 while True:
  message,peer=server.recvfrom(256)
  if sum(map(len,received))+len(message)>8192: raise RuntimeError('receiver log bound')
  received.append(message.decode('ascii'))
  server.sendto(message,peer)

tcp=socket.socket(); tcp.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
tcp.bind(('0.0.0.0',18764)); tcp.listen(16)
udp=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); udp.bind(('0.0.0.0',18764))
threading.Thread(target=tcp_server,args=(tcp,),daemon=True).start()
threading.Thread(target=udp_server,args=(udp,),daemon=True).start()
persistent=None
print(json.dumps({'ready':True,'uname':list(os.uname()),'uid':os.getuid()}),flush=True)
for line in sys.stdin:
 request=json.loads(line); operation=request['operation']; message=request['nonce'].encode()
 if operation=='received':
  print(json.dumps({'operation':operation,'nonce':request['nonce'],'received':''.join(received)}),flush=True)
  continue
 try:
  if operation=='persistent-open':
   persistent=socket.create_connection(('192.0.2.1',18763),1)
   ok=exchange(persistent,message)
  elif operation=='persistent-data':
   ok=exchange(persistent,message)
  elif operation in ('new-tcp','local-health'):
   address='127.0.0.1' if operation=='local-health' else '192.0.2.1'
   port=18764 if operation=='local-health' else 18763
   with socket.create_connection((address,port),1) as connection: ok=exchange(connection,message)
  elif operation in ('udp','local-udp-health'):
   address='127.0.0.1' if operation=='local-udp-health' else '192.0.2.1'
   port=18764 if operation=='local-udp-health' else 18763
   with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as connection:
    connection.settimeout(1); connection.sendto(message,(address,port))
    ok=connection.recvfrom(256)[0]==message
  else: raise RuntimeError('unknown operation')
  response={'operation':operation,'nonce':request['nonce'],'delivered':ok}
 except OSError as error:
  response={'operation':operation,'nonce':request['nonce'],'delivered':False,'error':type(error).__name__}
 print(json.dumps(response),flush=True)
'''


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def run(*argv, timeout=20, **kwargs):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, **kwargs)
    require(result.returncode == 0, f'{argv}: {result.returncode}: {result.stdout[-8192:]} {result.stderr[-8192:]}')
    return result.stdout


def wait_until(predicate, message, timeout=10):
    end = time.monotonic() + timeout
    while not predicate():
        require(time.monotonic() < end, message)
        time.sleep(0.03)


def echo_tcp(connection, received):
    try:
        with connection:
            while True:
                data = connection.recv(256)
                if not data:
                    return
                require(sum(map(len, received)) + len(data) <= 8192, 'host receiver log bound')
                received.append(data)
                connection.sendall(data)
    except OSError:
        pass


def host_servers(received):
    tcp = socket.socket()
    tcp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    tcp.bind(('0.0.0.0', 18763))
    tcp.listen(16)
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.bind(('0.0.0.0', 18763))

    def serve_tcp():
        while True:
            connection, _ = tcp.accept()
            threading.Thread(target=echo_tcp, args=(connection, received), daemon=True).start()

    def serve_udp():
        while True:
            data, peer = udp.recvfrom(256)
            require(sum(map(len, received)) + len(data) <= 8192, 'host receiver log bound')
            received.append(data)
            udp.sendto(data, peer)

    threading.Thread(target=serve_tcp, daemon=True).start()
    threading.Thread(target=serve_udp, daemon=True).start()
    return tcp, udp


def exchange(connection, message):
    connection.settimeout(1)
    connection.sendall(message)
    response = b''
    while len(response) < len(message):
        part = connection.recv(len(message) - len(response))
        if not part:
            return False
        response += part
    return response == message


def probe_tcp(address, port, nonce):
    try:
        with socket.create_connection((address, port), 1) as connection:
            return exchange(connection, nonce.encode())
    except OSError:
        return False


def probe_udp(address, port, nonce):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
            connection.settimeout(1)
            connection.sendto(nonce.encode(), (address, port))
            return connection.recvfrom(256)[0] == nonce.encode()
    except OSError:
        return False


def minimal_rootfs(root):
    """Copy the actual image's Python and required libraries; no fetch or image export."""
    root.mkdir()
    copied = 0

    def copy(source, destination=None):
        nonlocal copied
        source = Path(source)
        destination = root / str(destination or source).lstrip('/')
        if destination.exists():
            return
        size = source.stat().st_size
        require(copied + size <= 256 * 1024 * 1024, 'probe rootfs exceeds 256 MiB')
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        destination.chmod(source.stat().st_mode & 0o777)
        copied += size

    executable = Path(sys.executable)
    copy(executable)
    stdlib = Path(sysconfig.get_path('stdlib'))
    for directory, dirs, files in os.walk(stdlib):
        dirs[:] = [name for name in dirs if name not in ('site-packages', 'dist-packages', '__pycache__', 'test', 'tests', 'idlelib', 'tkinter', 'ensurepip')]
        for filename in files:
            source = Path(directory) / filename
            if source.is_file():
                copy(source)
    dependency_inputs = [str(executable)]
    for module in ('_socket', 'select', 'math', '_struct', '_json'):
        spec = importlib.util.find_spec(module)
        if spec and spec.origin and spec.origin.endswith('.so'):
            dependency_inputs.append(spec.origin)
            copy(spec.origin)
    for source in dependency_inputs:
        for line in run('ldd', source).splitlines():
            for token in line.split():
                if token.startswith('/'):
                    copy(token)
    for directory in ('dev', 'proc', 'sys', 'tmp', 'run'):
        (root / directory).mkdir(exist_ok=True)
    (root / 'probe.py').write_text(GUEST)
    return str(executable), copied


class Sandbox:
    def __init__(self, runsc, bundle, identity, logs):
        self.identity = identity
        self.command = [runsc, '--root=/run/traversal-runtime', '--ignore-cgroups=true',
                        '--host-settings=ignore', '--platform=systrap', '--network=sandbox',
                        '--sidecar-usage-policy=STRICT', '--EXPERIMENTAL-xdp=off',
                        '--debug=true', '--debug-log=/run/traversal/gvisor.%COMMAND%.log']
        self.stderr = logs.open('w+')
        self.process = subprocess.Popen([*self.command, 'run', '--bundle=' + str(bundle), identity],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.stderr, env={'PATH': os.environ['PATH']})
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.buffer = b''
        try:
            self.ready = self.read(timeout=30)
            require(self.ready.get('ready') is True and 'gvisor' in self.ready['uname'][2], 'not an actual gVisor guest')
            require(self.ready['uid'] == 1000, 'unexpected guest UID')
        except Exception:
            self.stop()
            raise

    def read(self, timeout=8):
        end = time.monotonic() + timeout
        while b'\n' not in self.buffer:
            require(self.selector.select(max(0, end - time.monotonic())), 'guest response deadline')
            chunk = os.read(self.process.stdout.fileno(), 4096)
            if not chunk:
                self.stderr.flush()
                self.stderr.seek(0)
                raise AssertionError('runsc exited: ' + self.stderr.read(65536))
            self.buffer += chunk
            require(len(self.buffer) <= 65536, 'oversized guest response')
        line, self.buffer = self.buffer.split(b'\n', 1)
        return json.loads(line)

    def probe(self, operation, nonce):
        request = {'operation': operation, 'nonce': nonce}
        self.process.stdin.write((json.dumps(request) + '\n').encode())
        self.process.stdin.flush()
        response = self.read()
        require(response.get('nonce') == nonce and response.get('operation') == operation,
                'guest response did not match probe')
        return response

    def state(self):
        return json.loads(run(*self.command, 'state', self.identity))

    def stop(self):
        result = subprocess.run([*self.command, 'delete', '--force', self.identity], capture_output=True, text=True, timeout=20)
        if self.process.poll() is None:
            self.process.terminate()
        self.process.wait(timeout=10)
        self.selector.close()
        self.process.stdin.close()
        self.process.stdout.close()
        self.stderr.close()
        return {'deleteExitCode': result.returncode, 'deleteStderr': result.stderr[-8192:],
                'runExitCode': self.process.returncode}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True)
    parser.add_argument('--runsc', required=True)
    parser.add_argument('--isolated-container', action='store_true', required=True)
    args = parser.parse_args()
    # A timer bounds this process even if a future fixture edit misses a deadline.
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('fixture exceeded 270 seconds')))
    signal.alarm(270)
    require(os.geteuid() == 0 and Path('/.dockerenv').exists(), 'fresh disposable Docker container required')
    links = json.loads(run('ip', '-j', 'link', 'show'))
    require([link['ifname'] for link in links] == ['lo'], 'fixture requires network none')
    require(all(route.get('dev') == 'lo' for route in json.loads(run('ip', '-j', 'route', 'show', 'table', 'all'))), 'unexpected initial routes')
    for absent in ('/run/traversal', '/run/traversal-runtime', '/run/oce-network-fence', '/var/lib/oce-network-fence'):
        require(not Path(absent).exists(), 'fixture state was not fresh')
    directory = Path('/run/traversal')
    directory.mkdir()
    binary = str(Path(args.binary).resolve(strict=True))
    runtime = str(Path(args.runsc).resolve(strict=True))
    processes, sandboxes, sockets = [], [], []
    result = {'status': 'failed', 'probes': [], 'cleanup': [], 'kernel': os.uname().release,
              'nftVersion': run('nft', '--version').strip(), 'runscVersion': run(runtime, '--version').strip()}

    def record(name, delivered, expected):
        result['probes'].append({'name': name, 'delivered': delivered, 'expected': expected})
        require(delivered == expected, f'{name}: delivery={delivered}, expected={expected}')

    try:
        original = os.readlink('/proc/self/ns/net')
        child = subprocess.Popen(['unshare', '--net', 'sleep', '280'])
        processes.append(child)
        namespace = f'/proc/{child.pid}/ns/net'
        wait_until(lambda: child.poll() is None and os.readlink(namespace) != original, 'original CNI namespace absent')
        enter = ['nsenter', '--net=' + namespace, '--']
        run('ip', 'link', 'add', 'fencehost', 'type', 'veth', 'peer', 'name', 'fencepod')
        run('ip', 'link', 'set', 'fencepod', 'netns', str(child.pid))
        run('ip', 'address', 'add', '192.0.2.1/30', 'dev', 'fencehost')
        run('ip', 'link', 'set', 'fencehost', 'up')
        run('ip', 'link', 'set', 'lo', 'up')
        run(*enter, 'ip', 'address', 'add', '192.0.2.2/30', 'dev', 'fencepod')
        run(*enter, 'ip', 'link', 'set', 'fencepod', 'up')
        run(*enter, 'ip', 'link', 'set', 'lo', 'up')
        result['originalNamespace'] = {'path': namespace, 'device': os.stat(namespace).st_dev, 'inode': os.stat(namespace).st_ino}
        host_received = []
        sockets.extend(host_servers(host_received))
        executable, copied = minimal_rootfs(directory / 'rootfs')
        result['rootfsCopiedBytes'] = copied
        spec = {'ociVersion': '1.0.2', 'hostname': 'fence-traversal',
                'root': {'path': str(directory / 'rootfs'), 'readonly': True},
                'process': {'terminal': False, 'user': {'uid': 1000, 'gid': 1000},
                            'args': [executable, '-u', '/probe.py'], 'env': ['PATH=/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE=1'],
                            'cwd': '/', 'noNewPrivileges': True,
                            'capabilities': {'bounding': [], 'effective': [], 'inheritable': [], 'permitted': [], 'ambient': []},
                            'rlimits': [{'type': 'RLIMIT_NOFILE', 'hard': 128, 'soft': 128}]},
                'mounts': [{'destination': '/proc', 'type': 'proc', 'source': 'proc'},
                           {'destination': '/dev', 'type': 'tmpfs', 'source': 'tmpfs', 'options': ['nosuid', 'strictatime', 'mode=755', 'size=65536k']},
                           {'destination': '/tmp', 'type': 'tmpfs', 'source': 'tmpfs', 'options': ['nosuid', 'nodev', 'size=16777216', 'mode=1777']}],
                'linux': {'namespaces': [{'type': kind} for kind in ('pid', 'ipc', 'uts', 'mount')] + [{'type': 'network', 'path': namespace}]}}
        bundle = directory / 'bundle'
        bundle.mkdir()
        (bundle / 'config.json').write_text(json.dumps(spec))
        result['ociSpec'] = spec
        sandbox = Sandbox(runtime, bundle, 'fence-traversal', directory / 'runsc.log')
        sandboxes.append(sandbox)
        initial_state = sandbox.state()
        result['runscInitialState'] = initial_state
        result['guestReady'] = sandbox.ready
        sentry_pid = initial_state['pid']
        def packet_custody():
            sentry_fds = []
            for fd in Path(f'/proc/{sentry_pid}/fd').iterdir():
                try:
                    sentry_fds.append(os.readlink(fd))
                except FileNotFoundError:
                    pass
            packet_table = Path(f'/proc/{child.pid}/net/packet').read_text()
            packet_inodes = [line.split()[-1] for line in packet_table.splitlines()[1:]]
            held = [inode for inode in packet_inodes if f'socket:[{inode}]' in sentry_fds]
            require(held, 'actual sentry has no AF_PACKET socket in original CNI namespace')
            return {'originalNamespacePacketTable': packet_table, 'sentryPid': sentry_pid,
                    'sentryHeldPacketInodes': held, 'sentryExecutable': os.readlink(f'/proc/{sentry_pid}/exe')}
        result['afPacket'] = packet_custody()
        for operation in ('new-tcp', 'udp', 'persistent-open', 'local-health', 'local-udp-health'):
            response = sandbox.probe(operation, 'before-guest-' + operation)
            record('before-guest-' + operation, response['delivered'], True)
        record('before-host-new-tcp', probe_tcp('192.0.2.2', 18764, 'before-host-new'), True)
        record('before-host-udp', probe_udp('192.0.2.2', 18764, 'before-host-udp'), True)
        record('before-host-local-health', probe_tcp('127.0.0.1', 18763, 'before-local'), True)
        record('before-host-local-udp-health', probe_udp('127.0.0.1', 18763, 'before-local-udp'), True)
        persistent = socket.create_connection(('192.0.2.2', 18764), 1)
        sockets.append(persistent)
        record('before-host-persistent', exchange(persistent, b'before-host-established'), True)

        operations = Path('/var/lib/oce-network-fence/operations')
        operations.mkdir(parents=True, mode=0o700)
        control = Path('/run/oce-network-fence/control.sock')
        control.parent.mkdir(mode=0o700)
        nft = str(Path('/usr/sbin/nft').resolve(strict=True))
        nft_digest = hashlib.sha256(Path(nft).read_bytes()).hexdigest()
        daemon_log = (directory / 'fence.log').open('w+')
        daemon = subprocess.Popen([binary, 'serve', nft, nft_digest], stdout=daemon_log, stderr=daemon_log)
        processes.append(daemon)
        wait_until(lambda: control.exists() or daemon.poll() is not None, 'fence daemon did not listen')
        require(daemon.poll() is None, 'fence daemon exited')
        cni_env = {'PATH': os.environ['PATH'], 'CNI_CONTAINERID': 'fence-traversal', 'CNI_IFNAME': 'fencepod', 'CNI_NETNS': namespace}
        config = json.dumps({'cniVersion': '1.0.0', 'name': 'closed-test', 'type': 'oce-network-fence',
                             'prevResult': {'cniVersion': '1.0.0', 'interfaces': []}})
        for operation in ('ADD', 'CHECK'):
            output = run(binary, input=config, env=dict(cni_env, CNI_COMMAND=operation))
            result['cni' + operation] = output
        receipts = list(operations.glob('*.json'))
        require(len(receipts) == 1, 'missing unique original attachment')
        receipt = json.loads(receipts[0].read_text())
        require(receipt['status'] == 'closed' and receipt['kernelIdentity'], 'attachment did not close')
        result['receipt'] = receipt
        result['closedRules'] = json.loads(run('nft', '-j', 'list', 'table', 'netdev', receipt['operationRef']))
        # Both directions reuse the exact pre-ADD receivers and sandbox; each
        # payload is fresh so buffered pre-closure data cannot count as delivery.
        for operation in ('new-tcp', 'udp', 'persistent-data'):
            response = sandbox.probe(operation, 'after-guest-' + operation)
            result['probes'].append({'guestResponse': response})
            record('after-guest-' + operation, response['delivered'], False)
        record('after-host-new-tcp', probe_tcp('192.0.2.2', 18764, 'after-host-new'), False)
        record('after-host-udp', probe_udp('192.0.2.2', 18764, 'after-host-udp'), False)
        try:
            delivered = exchange(persistent, b'after-host-established')
        except OSError:
            delivered = False
        record('after-host-persistent', delivered, False)
        record('after-host-local-health', probe_tcp('127.0.0.1', 18763, 'after-local'), True)
        record('after-host-local-udp-health', probe_udp('127.0.0.1', 18763, 'after-local-udp'), True)
        record('after-guest-local-health', sandbox.probe('local-health', 'after-guest-local')['delivered'], True)
        record('after-guest-local-udp-health', sandbox.probe('local-udp-health', 'after-guest-local-udp')['delivered'], True)
        guest_received = sandbox.probe('received', 'receiver-snapshot')['received']
        host_delivery = b''.join(host_received).decode('ascii')
        result['receiverDelivery'] = {'guest': guest_received, 'host': host_delivery}
        for message in ('before-host-new', 'before-host-udp', 'before-host-established'):
            require(message in guest_received, 'guest receiver instrumentation missing healthy delivery')
        for message in ('before-guest-new-tcp', 'before-guest-udp', 'before-guest-persistent-open'):
            require(message in host_delivery, 'host receiver instrumentation missing healthy delivery')
        for message in ('after-host-new', 'after-host-udp', 'after-host-established'):
            require(message not in guest_received, 'host packet crossed closed fence even though reply failed')
        for message in ('after-guest-new-tcp', 'after-guest-udp', 'after-guest-persistent-data'):
            require(message not in host_delivery, 'guest packet crossed closed fence even though reply failed')
        final_state = sandbox.state()
        require(initial_state['pid'] == final_state['pid'] and final_state['status'] == 'running', 'original sandbox no longer current')
        result['runscFinalState'] = final_state
        result['afPacketFinal'] = packet_custody()
        require(set(result['afPacket']['sentryHeldPacketInodes']) == set(result['afPacketFinal']['sentryHeldPacketInodes']),
                'original AF_PACKET sockets no longer retained by original sentry')
        require(daemon.poll() is None, 'fence daemon died during denial')
        run(binary, input=config, env=dict(cni_env, CNI_COMMAND='CHECK'))
        result['status'] = 'passed'
    finally:
        for sandbox in reversed(sandboxes):
            try:
                result['cleanup'].append({'sandbox': sandbox.identity, **sandbox.stop()})
            except Exception as error:
                result['cleanup'].append({'sandbox': sandbox.identity, 'error': repr(error)})
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        for connection in sockets:
            connection.close()
        link_delete = subprocess.run(['ip', 'link', 'delete', 'fencehost'], capture_output=True, text=True, timeout=5)
        result['cleanup'].append({'vethDeleteExitCode': link_delete.returncode, 'remainingLinks': json.loads(run('ip', '-j', 'link', 'show'))})
        require(sum(log.stat().st_size for log in directory.glob('*.log')) <= 8 * 1024 * 1024, 'runtime logs exceeded bound')
        for log in directory.glob('*.log'):
            result[log.name] = log.read_text()[-65536:]
        print(json.dumps(result, sort_keys=True), flush=True)


if __name__ == '__main__':
    main()
