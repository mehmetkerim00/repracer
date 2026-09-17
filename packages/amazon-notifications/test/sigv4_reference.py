# Независимая реализация SigV4 по тексту страницы AWS «Create a signed AWS API request» — источник ожидаемой подписи sigv4.test.ts.
# Запуск: python3 packages/amazon-notifications/test/sigv4_reference.py  (стандартная библиотека; ключи синтетические, из примеров AWS)
import hashlib, hmac
access_key = 'AKIAIOSFODNN7EXAMPLE'
secret = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE'
region, service = 'eu-west-1', 'sqs'
amz_date, day = '20260917T101500Z', '20260917'
body = '{"QueueUrl":"https://sqs.eu-west-1.amazonaws.com/000000000000/repracer-syn-notifications","MaxNumberOfMessages":10,"WaitTimeSeconds":20}'
headers = {
  'content-type': 'application/x-amz-json-1.0',
  'host': 'sqs.eu-west-1.amazonaws.com',
  'x-amz-date': amz_date,
  'x-amz-target': 'AmazonSQS.ReceiveMessage',
}
signed = sorted(headers)
canonical = '\n'.join(['POST', '/', '', ''.join(f'{h}:{headers[h]}\n' for h in signed), ';'.join(signed), hashlib.sha256(body.encode()).hexdigest()])
scope = f'{day}/{region}/{service}/aws4_request'
sts = '\n'.join(['AWS4-HMAC-SHA256', amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
def h(k, m): return hmac.new(k, m.encode(), hashlib.sha256).digest()
key = h(h(h(h(('AWS4' + secret).encode(), day), region), service), 'aws4_request')
print(hmac.new(key, sts.encode(), hashlib.sha256).hexdigest())
