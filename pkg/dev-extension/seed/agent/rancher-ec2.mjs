#!/usr/bin/env node
// A Rancher on one EC2 instance, made directly, with nothing between here and AWS.
//
// WHY THIS EXISTS, beside the Apps Plus `rancher-single` app that does the same job.
//
// That app asks for a Rancher like this: an AppInstance renders a Fleet Bundle, Fleet delivers
// it, Rancher's CAPI provisioner builds an EC2 node and registers it as a downstream cluster of
// the parent, a Helm release installs Rancher into that cluster, and a bootstrap sidecar
// configures it. Seven links, and every one of them has to keep working for ever - including a
// cluster-agent tunnel from AWS back to a Rancher on somebody's home connection, and two
// Ranchers reconciling one `cattle-system` because the installed one runs --add-local=true.
//
// Measured across fifty days and four instances, that tunnel never once held for five seconds.
// The specific defect behind it is fixed (a missing `cattle-system/rancher` Service), but the
// chain is still seven links long and each is a way to lose a Rancher.
//
// This is the other answer: run one EC2 instance whose user-data installs docker and starts
// `rancher/rancher` as a container. Three links - the instance, docker, the image - and the
// parent is not one of them. Nothing here registers a cluster, nothing waits on Fleet, and no
// agent has to dial home. It is the shape that has been working in the rancher-now project all
// along.
//
// WHAT IT GIVES UP, honestly. There is no downstream cluster, so the parent cannot proxy into
// it (it cannot today either - the agent is dead) and Fleet cannot deliver to it, which is how
// shares reach an instance now. A share here is another container on the same box, or a
// manifest applied with the instance's own kubeconfig; both are simpler than a Bundle.
//
// No SDK and no AWS CLI: the CLI is 222 MB in a pod that is rebuilt often, and the EC2 Query
// API over SigV4 is sixty lines of crypto that is already in node.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const REGION = process.env.AWS_REGION || 'us-west-2';
/** How this script recognises its own instances, and nothing else's. */
const TAG = 'dev.rancher.io/rancher';

/**
 * The credential, read from the one place it already lives.
 *
 * Rancher keeps cloud credentials in cattle-global-data as `amazonec2credentialConfig-*` keys.
 * Read through kubectl with this pod's own ServiceAccount rather than copied anywhere: there is
 * no second store to rotate, and nothing here ever prints it.
 */
function credential(name) {
  const raw = execFileSync('kubectl', [
    'get', 'secret', '-n', 'cattle-global-data', name, '-o', 'json',
  ], { encoding: 'utf8' });
  const data = JSON.parse(raw).data || {};
  const get = (key) => Buffer.from(data[`amazonec2credentialConfig-${ key }`] || '', 'base64').toString('utf8').trim();
  const id = get('accessKey');
  const secret = get('secretKey');

  if (!id || !secret) {
    throw new Error(`${ name } is not an amazonec2 credential`);
  }

  return { id, secret, region: get('defaultRegion') || REGION };
}

const hmac = (key, value) => crypto.createHmac('sha256', key).update(value, 'utf8').digest();
const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * One EC2 Query API call, signed.
 *
 * POST with a form body, which keeps the canonical request trivial: the path is always `/`, the
 * query string is always empty, and the only signed headers are the three that have to be.
 */
async function ec2(cred, params) {
  const host = `ec2.${ cred.region }.amazonaws.com`;
  const body = new URLSearchParams({ Version: '2016-11-15', ...params }).toString();
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = now.slice(0, 8);
  const scope = `${ day }/${ cred.region }/ec2/aws4_request`;
  const canonical = [
    'POST', '/', '',
    `content-type:application/x-www-form-urlencoded; charset=utf-8`,
    `host:${ host }`,
    `x-amz-date:${ now }`,
    '', 'content-type;host;x-amz-date', sha256(body),
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256(canonical)].join('\n');
  const signature = hmac(
    hmac(hmac(hmac(hmac(`AWS4${ cred.secret }`, day), cred.region), 'ec2'), 'aws4_request'),
    toSign,
  ).toString('hex');
  const response = await fetch(`https://${ host }/`, {
    method:  'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      'x-amz-date':   now,
      authorization:  `AWS4-HMAC-SHA256 Credential=${ cred.id }/${ scope }, SignedHeaders=content-type;host;x-amz-date, Signature=${ signature }`,
    },
    body,
  });
  const text = await response.text();

  if (!response.ok) {
    // The message, not the whole XML document, and never the request that carried the key.
    throw new Error(`EC2 ${ params.Action } -> ${ response.status }: ${ (/<Message>([^<]*)</.exec(text) || [])[1] || text.slice(0, 200) }`);
  }

  return text;
}

/** Everything between a repeated XML tag, which is all the parsing this needs. */
function all(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${ tag }>([\\s\\S]*?)</${ tag }>`, 'g'))].map((m) => m[1]);
}

function one(xml, tag) {
  return (new RegExp(`<${ tag }>([\\s\\S]*?)</${ tag }>`).exec(xml) || [])[1] || '';
}

/**
 * The newest Ubuntu 24.04 image, asked of AWS rather than written down.
 *
 * A hard-coded AMI id is wrong in every region but one and goes stale the first time Canonical
 * publishes; this is one call and is always right.
 */
async function ubuntu(cred) {
  const xml = await ec2(cred, {
    Action:                      'DescribeImages',
    'Owner.1':                   '099720109477',
    'Filter.1.Name':             'name',
    'Filter.1.Value.1':          'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*',
    'Filter.2.Name':             'state',
    'Filter.2.Value.1':          'available',
  });
  const images = all(xml, 'item')
    .filter((i) => one(i, 'imageId'))
    .map((i) => ({ id: one(i, 'imageId'), at: one(i, 'creationDate') }))
    .sort((a, b) => b.at.localeCompare(a.at));

  if (!images.length) {
    throw new Error('no Ubuntu 24.04 image found in this region');
  }

  return images[0].id;
}

/**
 * What the instance runs on first boot.
 *
 * `--restart=unless-stopped` is the whole availability story: the box reboots, docker comes
 * back, Rancher comes back. No agent, no tunnel, nothing to reconnect.
 *
 * The two sysctls are not optional - Rancher runs k3s inside this container and the default
 * inotify limits are too low for it, which shows up as a Rancher that starts and then wedges.
 */
function userData(image, password) {
  return Buffer.from(`#!/bin/bash
set -eux
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y docker.io
systemctl enable --now docker
sysctl -w fs.inotify.max_user_instances=1024 || true
sysctl -w fs.inotify.max_user_watches=524288 || true
echo 'fs.inotify.max_user_instances=1024' >> /etc/sysctl.conf
echo 'fs.inotify.max_user_watches=524288' >> /etc/sysctl.conf

# The certificate, decided here because only here knows the address.
#
# Let's Encrypt needs a NAME, and this box is given an IP minutes after anything that could
# have written a name into this script. sslip.io resolves <ip>.sslip.io straight back to that
# ip with no DNS to own, which is the same trick the shares already use - so the instance asks
# the metadata service what it is and hands Rancher --acme-domain for that name. Rancher then
# gets and renews the certificate itself; there is no cert-manager and nothing to expire
# quietly.
#
# IMDSv2: the token call first, because a plain GET of the metadata service is refused on a
# modern AMI and would leave HOST empty.
TOK=$(curl -sX PUT 'http://169.254.169.254/latest/api/token' -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' || true)
IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOK" http://169.254.169.254/latest/meta-data/public-ipv4 || true)
HOST="\${IP}.sslip.io"
echo "$HOST" > /var/log/rancher-host

docker run -d --name rancher --privileged --restart=unless-stopped \\
  -p 80:80 -p 443:443 \\
  -e CATTLE_BOOTSTRAP_PASSWORD='${ password }' \\
  ${ image } --acme-domain "$HOST"
touch /var/log/rancher-bootstrap-done
`).toString('base64');
}

/** The name this instance's certificate is for, and what server-url has to say. */
const hostFor = (ip) => `${ ip }.sslip.io`;

/**
 * Where to put it, when nobody said.
 *
 * The point of this tool is that `create <name>` works, so the network it needs is discovered
 * rather than configured: the account's default VPC, one of its default subnets, and a security
 * group of this tool's own. A caller that knows better still passes RANCHER_EC2_SUBNET and
 * RANCHER_EC2_SG and none of this runs.
 */
async function defaultNetwork(cred) {
  const vpcs = await ec2(cred, {
    Action: 'DescribeVpcs', 'Filter.1.Name': 'isDefault', 'Filter.1.Value.1': 'true',
  });
  const vpcId = one(vpcs, 'vpcId');

  if (!vpcId) {
    throw new Error('no default VPC in this region; set RANCHER_EC2_SUBNET and RANCHER_EC2_SG');
  }

  const subnets = await ec2(cred, {
    Action: 'DescribeSubnets', 'Filter.1.Name': 'vpc-id', 'Filter.1.Value.1': vpcId,
  });
  const subnet = all(subnets, 'item').map((i) => one(i, 'subnetId')).filter(Boolean)[0];

  return { vpcId, subnet };
}

/**
 * The security group, found or made.
 *
 * 80 and 443 from anywhere, because the whole point of this Rancher is that it has a public
 * address a browser and an agent can reach. Nothing else is opened - no 22, because this box is
 * not meant to be logged into: it runs one container and `docker logs` is reachable through
 * nothing here. Add SSH deliberately if you want it.
 */
async function securityGroup(cred, vpcId) {
  const existing = await ec2(cred, {
    Action:             'DescribeSecurityGroups',
    'Filter.1.Name':    'group-name',
    'Filter.1.Value.1': 'rancher-ec2',
    'Filter.2.Name':    'vpc-id',
    'Filter.2.Value.1': vpcId,
  });
  const found = one(existing, 'groupId');

  if (found) {
    return found;
  }

  const made = await ec2(cred, {
    Action:           'CreateSecurityGroup',
    GroupName:        'rancher-ec2',
    GroupDescription: 'Rancher on one EC2 instance (dev-extension)',
    VpcId:            vpcId,
  });
  const id = one(made, 'groupId');

  for (const [n, port] of [80, 443].entries()) {
    await ec2(cred, {
      Action:                                  'AuthorizeSecurityGroupIngress',
      GroupId:                                 id,
      [`IpPermissions.${ n + 1 }.IpProtocol`]: 'tcp',
      [`IpPermissions.${ n + 1 }.FromPort`]:   String(port),
      [`IpPermissions.${ n + 1 }.ToPort`]:     String(port),
      [`IpPermissions.${ n + 1 }.IpRanges.1.CidrIp`]: '0.0.0.0/0',
    });
  }

  return id;
}

async function create(cred, name, opts) {
  const ami = opts.ami || await ubuntu(cred);
  let { subnet, securityGroup: sg } = opts;

  if (!subnet || !sg) {
    const net = await defaultNetwork(cred);

    subnet = subnet || net.subnet;
    sg = sg || await securityGroup(cred, net.vpcId);
  }
  const password = opts.password || crypto.randomBytes(16).toString('base64url');
  const params = {
    Action:                                        'RunInstances',
    ImageId:                                       ami,
    InstanceType:                                  opts.type,
    MinCount:                                      '1',
    MaxCount:                                      '1',
    UserData:                                      userData(opts.image, password),
    'BlockDeviceMapping.1.DeviceName':             '/dev/sda1',
    'BlockDeviceMapping.1.Ebs.VolumeSize':         String(opts.rootSize),
    // gp3 for the same reason the Apps Plus app chose it: a gp2 root's baseline is 3 IOPS per
    // GiB, and etcd inside this container is what everything else waits behind.
    'BlockDeviceMapping.1.Ebs.VolumeType':         'gp3',
    'BlockDeviceMapping.1.Ebs.DeleteOnTermination': 'true',
    'TagSpecification.1.ResourceType':             'instance',
    'TagSpecification.1.Tag.1.Key':                'Name',
    'TagSpecification.1.Tag.1.Value':              name,
    'TagSpecification.1.Tag.2.Key':                TAG,
    'TagSpecification.1.Tag.2.Value':              name,
  };

  if (sg) {
    params['SecurityGroupId.1'] = sg;
  }
  if (subnet) {
    params.SubnetId = subnet;
  }
  if (opts.keyName) {
    params.KeyName = opts.keyName;
  }
  // AWS validates everything and launches nothing, which is how this tool is tested without
  // billing somebody for a box. It answers with a DryRunOperation error on success, so that
  // one error is the pass.
  if (opts.dryRun) {
    params.DryRun = 'true';

    try {
      await ec2(cred, params);
    } catch (e) {
      const ok = /DryRunOperation|Request would have succeeded/.test(String(e.message || e));

      console.log(JSON.stringify({
        dryRun: true, ok, ami, subnet, securityGroup: sg, detail: ok ? 'would launch' : String(e.message || e),
      }));

      return '';
    }

    console.log(JSON.stringify({ dryRun: true, ok: false, detail: 'AWS did not answer DryRunOperation' }));

    return '';
  }

  const xml = await ec2(cred, params);
  const id = one(xml, 'instanceId');

  // Kept in a Secret, not the ConfigMap the dashboard reads: `configure` needs it minutes
  // later, and asking somebody to copy a password out of a log is how it ends up in one.
  savePassword(name, password);

  console.log(JSON.stringify({
    name, instanceId: id, ami, password, state: 'pending',
  }));

  return id;
}

async function list(cred) {
  const xml = await ec2(cred, {
    Action:             'DescribeInstances',
    'Filter.1.Name':    `tag:${ TAG }`,
    'Filter.1.Value.1': '*',
    'Filter.2.Name':    'instance-state-name',
    'Filter.2.Value.1': 'pending',
    'Filter.2.Value.2': 'running',
    'Filter.2.Value.3': 'stopped',
  });

  /*
   * Sliced on `<instanceId>` rather than on `<item>`.
   *
   * EC2 nests items three deep - reservationSet > item > instancesSet > item - and the tag set
   * inside an instance is a list of items too, so matching `<item>` with a regex pairs the
   * wrong open and close tags and the name came back empty. `instanceId` is the first field of
   * each instance, so the text from one to the next is exactly that instance's own fields.
   */
  const at = [...xml.matchAll(/<instanceId>([^<]+)<\/instanceId>/g)];

  return at.map((m, n) => {
    const block = xml.slice(m.index, n + 1 < at.length ? at[n + 1].index : undefined);
    const tags = all(one(block, 'tagSet'), 'item');

    return {
      name:  tags.map((t) => (one(t, 'key') === TAG ? one(t, 'value') : '')).find(Boolean) || '',
      id:    m[1],
      state: one(one(block, 'instanceState'), 'name'),
      ip:    one(block, 'ipAddress'),
    };
  }).filter((i) => i.id);
}

/**
 * Every instance in the account, tagged or not.
 *
 * Because the ones that cost money quietly are the ones nothing lists. A node left behind by a
 * deleted Rancher keeps running, keeps its public address, and in at least one case kept
 * dialling the parent 6,302 times in six hours - and `list` could not see it, because `list`
 * only knows instances this tool tagged.
 */
async function orphans(cred) {
  const xml = await ec2(cred, {
    Action:             'DescribeInstances',
    'Filter.1.Name':    'instance-state-name',
    'Filter.1.Value.1': 'running',
    'Filter.1.Value.2': 'pending',
  });
  const at = [...xml.matchAll(/<instanceId>([^<]+)<\/instanceId>/g)];

  return at.map((m, n) => {
    const block = xml.slice(m.index, n + 1 < at.length ? at[n + 1].index : undefined);
    const tags = all(one(block, 'tagSet'), 'item');
    const named = (key) => tags.map((t) => (one(t, 'key') === key ? one(t, 'value') : '')).find(Boolean) || '';

    return {
      id:      m[1],
      ours:    !!named(TAG),
      name:    named(TAG) || named('Name') || '(untagged)',
      ip:      one(block, 'ipAddress'),
      state:   one(one(block, 'instanceState'), 'name'),
      since:   one(block, 'launchTime'),
    };
  }).filter((i) => i.id);
}

/**
 * Terminate, by this tool's name for it or by instance id.
 *
 * The id form exists for the ones this tool did not create: a node left behind by a deleted
 * Rancher is not tagged, so `list` cannot see it, and the only handle anybody has is the id or
 * the Name tag that shows in `orphans`.
 *
 * It refuses an ambiguous match rather than picking one. This call cannot be undone, the
 * account has a dozen instances belonging to other people in it, and "it matched two, so I did
 * the first" is not a sentence worth being able to write afterwards.
 */
async function remove(cred, name) {
  let found = (await list(cred)).filter((i) => i.name === name || i.id === name);

  if (!found.length) {
    found = (await orphans(cred))
      .filter((i) => i.id === name || i.name === name)
      .map((i) => ({ name: i.name, id: i.id, state: i.state, ip: i.ip }));
  }

  if (found.length > 1) {
    throw new Error(`${ name } matches ${ found.length } instances (${ found.map((i) => i.id).join(', ') }); name one by id`);
  }

  if (!found.length) {
    throw new Error(`no instance called ${ name }`);
  }
  console.error(`terminating ${ found[0].id } (${ found[0].name }, ${ found[0].ip || 'no public ip'})`);
  for (const [n, instance] of found.entries()) {
    await ec2(cred, { Action: 'TerminateInstances', [`InstanceId.${ n + 1 }`]: instance.id });
  }
  console.log(JSON.stringify({ terminated: found.map((i) => i.id) }));
}

/**
 * What the extension reads, because a browser cannot call EC2.
 *
 * One ConfigMap in dev-system holding every instance this tool knows about. Written after each
 * create, delete and sync, so the list in the sidebar is the list in the account rather than a
 * second thing to keep in step by hand.
 *
 * The bootstrap password is NOT in here. It is shown once, by `create`, and this record is read
 * by every page of the dashboard; a password in it would be a password in everybody's browser.
 */
/**
 * Is Rancher actually answering, as opposed to the box being switched on?
 *
 * `state: running` is EC2's opinion of the hardware and says nothing about the container - a
 * box that is up but pulling the image, or whose Rancher has fallen over, reports `running`
 * just the same. The status beside an instance should be the status of the thing you click
 * through to, so the record carries the answer to /ping.
 */
async function answering(ip) {
  try {
    const r = await fetch(`https://${ hostFor(ip) }/ping`, { signal: AbortSignal.timeout(8000) });

    return r.ok;
  } catch {
    return false;
  }
}

async function record(cred) {
  const instances = await list(cred);
  const health = Object.fromEntries(await Promise.all(
    instances.filter((i) => i.ip).map(async(i) => [i.id, await answering(i.ip)]),
  ));
  const doc = JSON.stringify({
    at: new Date().toISOString(),
    instances: instances.filter((i) => i.name).map((i) => ({
      up: !!health[i.id],
      // The sslip name, not the bare address: that is the name the Let's Encrypt certificate
      // is issued for, so it is the only one a browser opens without a warning.
      name: i.name, instanceId: i.id, state: i.state, ip: i.ip, url: i.ip ? `https://${ hostFor(i.ip) }` : '',
    })),
  });

  // Rendered once and applied through a pipe, so it is a create-or-update rather than a create
  // that fails the second time.
  const yaml = execFileSync('kubectl', [
    'create', 'configmap', 'dev-rancher-ec2', '-n', 'dev-system',
    `--from-literal=instances.json=${ doc }`, '--dry-run=client', '-o', 'yaml',
  ], { encoding: 'utf8' });

  // The LABELLED output is what gets applied. Piping `yaml` here instead was a label that was
  // computed, printed to nowhere and dropped - the ConfigMap landed unlabelled and nothing
  // selecting on the label could find it.
  const labelled = execFileSync('kubectl', [
    'label', '--local', '-f', '-', 'dev.rancher.io/kind=rancher-ec2', '--dry-run=client', '-o', 'yaml',
  ], { encoding: 'utf8', input: yaml });

  execFileSync('kubectl', ['apply', '-f', '-'], { encoding: 'utf8', input: labelled });

  return instances;
}

// ── Making it a Rancher somebody can actually use ──────────────────────────────────────────
//
// A box running `rancher/rancher` is a login prompt, not a Rancher: no address it knows itself
// by, no Cluster Management, no way in but a bootstrap password nobody wants to share. The
// Apps Plus app does the rest with a sidecar that has kubectl inside the cluster; there is no
// sidecar here, so the same work is done over Rancher's own API from this pod.
//
// Everything below is idempotent. `configure` is safe to run again, and running it again is how
// a half-finished instance is finished.

/** A token for the instance, from the bootstrap password. */
async function login(url, password) {
  const r = await fetch(`${ url }/v3-public/localProviders/local?action=login`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ username: 'admin', password, ttl: 3600000 }),
  });

  if (!r.ok) {
    throw new Error(`login -> ${ r.status } (is the bootstrap password right?)`);
  }

  return (await r.json()).token;
}

async function api(url, token, path, method = 'GET', body = null) {
  const r = await fetch(`${ url }${ path }`, {
    method,
    headers: {
      authorization: `Bearer ${ token }`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();

  if (!r.ok) {
    throw new Error(`${ method } ${ path } -> ${ r.status }: ${ text.slice(0, 200) }`);
  }

  return text ? JSON.parse(text) : null;
}

/** What this Rancher's own GitHub login should look like: whatever the parent's does. */
function parentGithub() {
  const read = (args) => {
    try {
      return execFileSync('kubectl', args, { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };
  const clientId = read(['get', 'authconfig', 'github', '-o', 'jsonpath={.clientId}']);
  const principals = read(['get', 'authconfig', 'github', '-o', 'jsonpath={.allowedPrincipalIds}']);
  const secret = read([
    'get', 'secret', '-n', 'cattle-global-data', 'githubconfig-clientsecret',
    '-o', 'jsonpath={.data.clientsecret}',
  ]);

  const allowed = (() => {
    try {
      return JSON.parse(principals || '[]');
    } catch {
      return [];
    }
  })();

  /*
   * The rancher org, always.
   *
   * An instance is made to be shown to somebody - a share, a reviewer, whoever is being asked
   * to look at the thing - and an allow-list of one person is a Rancher only its maker can
   * open. `github_org://9343010` is the rancher organisation, which is the same id the Apps
   * Plus app has written into every instance it has ever made; this keeps the two paths
   * agreeing about who gets in.
   */
  const RANCHER_ORG = 'github_org://9343010';

  return {
    clientId,
    clientSecret: secret ? Buffer.from(secret, 'base64').toString('utf8') : '',
    allowed:      [...new Set([...allowed, RANCHER_ORG])],
  };
}

/**
 * Everything the sidecar does for an Apps Plus instance, over the API instead.
 *
 * Order matters in one place only: the client secret has to exist before the AuthConfig that
 * names it, because Rancher resolves `cattle-global-data:githubconfig-clientsecret` when the
 * config is saved and refuses one that points at nothing.
 */
async function configure(cred, name, opts) {
  const found = (await list(cred)).find((i) => i.name === name);

  if (!found?.ip) {
    throw new Error(`no running instance called ${ name }`);
  }
  const host = hostFor(found.ip);
  const url = `https://${ found.ip }`;
  const password = opts.password || readPassword(name);

  if (!password) {
    throw new Error(`no bootstrap password for ${ name }; pass RANCHER_EC2_PASSWORD`);
  }

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // its cert is for the sslip name, not the ip
  const token = await login(url, password);
  const done = [];

  // 1. The address it tells everything else to reach it on - the sslip name the certificate
  //    is for, not the bare ip, or every agent it ever provisions gets a TLS error.
  await api(url, token, '/v3/settings/server-url', 'PUT', { name: 'server-url', value: `https://${ host }` });
  done.push(`server-url https://${ host }`);

  /*
   * 2. First-time setup, finished.
   *
   * Logging in with the bootstrap password is not the same as having set the thing up: Rancher
   * keeps `first-login: true` until the wizard is done, and shows "Welcome to Rancher - it
   * looks like this is your first time visiting" to everybody, including the person who has
   * just been handed the address. The wizard sets three things and so does this.
   *
   * telemetry is set to `out` rather than left unset, because unset is a question Rancher will
   * ask the first person through the door and nobody asked for this box to phone home.
   */
  const setting = async(nameOf, value) => {
    try {
      await api(url, token, `/v3/settings/${ nameOf }`, 'PUT', { name: nameOf, value });

      return true;
    } catch {
      return false;
    }
  };
  // Reported one at a time, by whether it took. The first version said "eula, telemetry out,
  // first-login false" as one line whatever happened, and telemetry-opt had in fact failed -
  // a summary that is written before the result is a summary that can be wrong.
  const eula = await setting('eula-agreed', new Date().toISOString());
  const telemetry = await setting('telemetry-opt', 'out');

  await api(url, token, '/v3/settings/first-login', 'PUT', { name: 'first-login', value: 'false' });
  done.push(`first-login false${ eula ? ', eula agreed' : ', EULA NOT set' }${ telemetry ? ', telemetry out' : ', telemetry-opt NOT set' }`);

  // 3. Cluster Management and the rest. Not dynamic: they take on the next start, and Rancher
  //    in this container restarts itself when a feature changes.
  for (const flag of ['multi-cluster-management', 'fleet', 'rke2']) {
    await api(url, token, `/v3/features/${ flag }`, 'PUT', { name: flag, value: true }).catch(() => undefined);
  }
  done.push('features: multi-cluster-management, fleet, rke2');

  // 4. GitHub, mirroring the parent's own configuration so the same people get in.
  const gh = parentGithub();

  if (!gh.clientId || !gh.clientSecret) {
    done.push('github login SKIPPED: the parent has no clientId/secret to copy');
  } else if (!gh.allowed.length) {
    /*
     * Refused rather than guessed at, and this is the one place in this file worth being
     * timid. `accessMode: restricted` with an empty allow-list is a Rancher that lets nobody
     * in through GitHub - and since enabling GitHub is also what stops the local admin being
     * the way in, getting this wrong locks the owner out of a box they are paying for.
     */
    done.push('github login SKIPPED: the parent lists no allowed principals, and enabling restricted access with an empty list would lock everyone out');
  } else {
    /*
     * `/v3/githubConfigs/github`, not the Steve path.
     *
     * `PUT /v1/management.cattle.io.authconfigs/github` answers 403 "Method PUT not
     * supported" - Steve does not take writes for this kind. The v3 resource advertises an
     * `update` link and takes the whole config, with the client secret as a literal; Rancher
     * puts it in cattle-global-data itself, so there is no secret to create first.
     */
    await api(url, token, '/v3/githubConfigs/github', 'PUT', {
      name:                'github',
      type:                'githubConfig',
      enabled:             true,
      accessMode:          'restricted',
      allowedPrincipalIds: gh.allowed,
      clientId:            gh.clientId,
      clientSecret:        gh.clientSecret,
      hostname:            'github.com',
      tls:                 true,
    });
    done.push(`github login for ${ gh.allowed.length } principal(s)`);
  }

  /*
   * 5. The cloud credentials, so this Rancher can provision something of its own.
   *
   * The same set the Apps Plus app hands an instance: the secrets in cattle-global-data that
   * carry `dev.rancher.io/propagate-to-instances`, copied verbatim. They are secrets rather
   * than /v3/cloudcredentials objects because that is what Rancher reads its credential list
   * from, and copying the object the working path already copies is one fewer shape to get
   * wrong.
   */
  for (const cc of propagatedCredentials()) {
    await api(url, token, '/v1/secrets', 'POST', {
      type:       'Opaque',
      metadata:   { name: cc.name, namespace: 'cattle-global-data', annotations: cc.annotations },
      data:       cc.data,
    }).catch(() => undefined); // already there on a second run
  }
  const copied = propagatedCredentials().length;

  done.push(copied ? `${ copied } cloud credential(s) copied` : 'no cloud credentials marked to propagate');

  console.log(JSON.stringify({
    name, url: `https://${ host }`, ip: found.ip, configured: done,
  }, null, 1));
}

/**
 * The cloud credentials marked to travel, read from the parent.
 *
 * `dev.rancher.io/propagate-to-instances` is the extension's own marker and the Apps Plus path
 * already uses it, so what an instance gets is decided in one place rather than two. The
 * annotations Kubernetes and Helm add are dropped; `field.cattle.io/name` is kept, because
 * without it the credential shows in Rancher's list with no name.
 */
function propagatedCredentials() {
  try {
    const raw = execFileSync('kubectl', [
      'get', 'secrets', '-n', 'cattle-global-data',
      '-l', 'dev.rancher.io/propagate-to-instances', '-o', 'json',
    ], { encoding: 'utf8' });
    let items = JSON.parse(raw).items || [];

    // The marker is an annotation on these, not a label, so the selector above matches nothing
    // and everything has to be read and filtered. Kept as a selector too in case they are ever
    // labelled: a narrower server-side read is better when it works.
    if (!items.length) {
      items = (JSON.parse(execFileSync('kubectl', [
        'get', 'secrets', '-n', 'cattle-global-data', '-o', 'json',
      ], { encoding: 'utf8' })).items || [])
        .filter((x) => (x.metadata?.annotations || {})['dev.rancher.io/propagate-to-instances'] === 'true');
    }

    return items.map((x) => ({
      name:        x.metadata.name,
      data:        x.data || {},
      annotations: Object.fromEntries(Object.entries(x.metadata.annotations || {})
        .filter(([k]) => k.startsWith('field.cattle.io/'))),
    }));
  } catch {
    return [];
  }
}

/** The bootstrap password, kept where only an admin can read it - never in the ConfigMap. */
function savePassword(name, password) {
  const yaml = execFileSync('kubectl', [
    'create', 'secret', 'generic', `dev-rancher-ec2-${ name }`, '-n', 'dev-system',
    `--from-literal=password=${ password }`, '--dry-run=client', '-o', 'yaml',
  ], { encoding: 'utf8' });

  execFileSync('kubectl', ['apply', '-f', '-'], { encoding: 'utf8', input: yaml });
}

function readPassword(name) {
  try {
    const b64 = execFileSync('kubectl', [
      'get', 'secret', '-n', 'dev-system', `dev-rancher-ec2-${ name }`, '-o', 'jsonpath={.data.password}',
    ], { encoding: 'utf8' }).trim();

    return b64 ? Buffer.from(b64, 'base64').toString('utf8') : '';
  } catch {
    return '';
  }
}

async function main() {
  const [verb, name] = process.argv.slice(2);
  const opts = {
    credential:    process.env.RANCHER_EC2_CREDENTIAL || '',
    type:          process.env.RANCHER_EC2_TYPE || 't3.xlarge',
    rootSize:      process.env.RANCHER_EC2_ROOT || '100',
    image:         process.env.RANCHER_EC2_IMAGE || 'rancher/rancher:v2.12.3',
    securityGroup: process.env.RANCHER_EC2_SG || '',
    subnet:        process.env.RANCHER_EC2_SUBNET || '',
    keyName:       process.env.RANCHER_EC2_KEY || '',
    ami:           process.env.RANCHER_EC2_AMI || '',
    password:      process.env.RANCHER_EC2_PASSWORD || '',
    dryRun:        process.env.RANCHER_EC2_DRYRUN === '1',
  };

  if (!opts.credential) {
    throw new Error('RANCHER_EC2_CREDENTIAL must name a cattle-global-data secret (a cc-xxxxx)');
  }
  const cred = credential(opts.credential);

  if (verb === 'create') {
    if (!name) {
      throw new Error('create needs a name');
    }
    await create(cred, name, opts);
    await record(cred).catch(() => undefined);
  } else if (verb === 'orphans') {
    const rows = await orphans(cred);

    console.log(JSON.stringify({
      ours:  rows.filter((r) => r.ours),
      other: rows.filter((r) => !r.ours),
    }, null, 1));
  } else if (verb === 'configure') {
    if (!name) {
      throw new Error('configure needs a name');
    }
    await configure(cred, name, opts);
  } else if (verb === 'sync') {
    // What boot.sh runs on a timer: the account is the truth, this copies it where the
    // dashboard can see it.
    console.log(JSON.stringify(await record(cred), null, 1));
  } else if (verb === 'list') {
    console.log(JSON.stringify(await list(cred), null, 1));
  } else if (verb === 'delete') {
    if (!name) {
      throw new Error('delete needs a name');
    }
    await remove(cred, name);
    await record(cred).catch(() => undefined);
  } else {
    console.error('usage: rancher-ec2.mjs create <name> | configure <name> | list | orphans | sync | delete <name>');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
