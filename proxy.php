<?php
/* ELPP read-only data proxy for Hostinger (or any PHP host).
   Upload this file next to index.html. The scanner finds it by itself (same folder).
   It only fetches an allow-list of public market-data URLs, so it cannot be used as an open proxy. */
header('Content-Type: text/plain; charset=utf-8');
header('X-ELPP-Proxy: 1');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: no-store');
function fail($code, $msg){ http_response_code($code); echo json_encode(['error' => $msg]); exit; }
$u = isset($_GET['u']) ? (string)$_GET['u'] : '';
if ($u === '' || strlen($u) > 600) fail(400, 'missing url');
$p = parse_url($u);
if (!$p || ($p['scheme'] ?? '') !== 'https' || isset($p['user']) || isset($p['port'])) fail(400, 'bad url');
$host = strtolower($p['host'] ?? ''); $path = $p['path'] ?? '/';
/* host => [allowed path pattern, cache seconds] */
$ALLOW = [
  'fred.stlouisfed.org'      => ['#^/graph/fredgraph\.csv$#', 3600],
  'www.binance.com'          => ['#^/bapi/composite/v1/public/cms/article/list/query$#', 300],
  'mempool.space'            => ['#^/api/(v1/)?[a-z/]+$#', 120],
  'query1.finance.yahoo.com' => ['#^/v8/finance/chart/[A-Za-z0-9\^\.\-=]+$#', 60],
  'cftc.gov'                 => ['#^/dea/newcot/#', 21600],
  'www.cftc.gov'             => ['#^/dea/newcot/#', 21600],
];
if (!isset($ALLOW[$host]) || !preg_match($ALLOW[$host][0], $path)) fail(403, 'host or path not allowed');
$ttl = $ALLOW[$host][1];
$cf = sys_get_temp_dir() . '/elpp_px_' . md5($u) . '.cache';
if (is_file($cf) && time() - filemtime($cf) < $ttl) { echo file_get_contents($cf); exit; }
$body = false; $code = 0;
if (function_exists('curl_init')) {
  $ch = curl_init($u);
  curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 3, CURLOPT_TIMEOUT => 12, CURLOPT_CONNECTTIMEOUT => 6,
    CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_MAXFILESIZE => 3000000,
    CURLOPT_USERAGENT => 'Mozilla/5.0 (compatible; ELPP-Scanner/1.0)', CURLOPT_HTTPHEADER => ['Accept: application/json,text/csv,*/*']]);
  $body = curl_exec($ch); $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
} else {
  $ctx = stream_context_create(['http' => ['timeout' => 12, 'header' => "User-Agent: Mozilla/5.0 (compatible; ELPP-Scanner/1.0)\r\n"]]);
  $body = @file_get_contents($u, false, $ctx); $code = $body === false ? 0 : 200;
}
if ($body === false || $code < 200 || $code >= 300 || strlen($body) > 3000000) {
  if (is_file($cf)) { echo file_get_contents($cf); exit; }  /* serve stale data if the source is down */
  fail(502, 'upstream failed (' . $code . ')');
}
@file_put_contents($cf, $body);
echo $body;
