resource "aws_lambda_function" "move_granules_task" {
  function_name    = "${var.prefix}-MoveGranules"
  filename         = "${path.module}/../../tasks/move-granules/dist/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../../tasks/move-granules/dist/lambda.zip")
  handler          = "index.handler"
  role             = var.lambda_processing_role_arn
  runtime          = "nodejs14.x"
  timeout          = lookup(var.lambda_timeouts, "move_granules_task_timeout", 300)
  memory_size      = 1024

  layers = [var.cumulus_message_adapter_lambda_layer_version_arn]

  environment {
    variables = {
      CMR_ENVIRONMENT                   = var.cmr_environment
      CMR_HOST                          = var.cmr_custom_host
      CUMULUS_MESSAGE_ADAPTER_DIR       = "/opt/"
      default_s3_multipart_chunksize_mb = var.default_s3_multipart_chunksize_mb
      stackName                         = var.prefix
      system_bucket                     = var.system_bucket
    }
  }

  dynamic "vpc_config" {
    for_each = length(var.lambda_subnet_ids) == 0 ? [] : [1]
    content {
      subnet_ids = var.lambda_subnet_ids
      security_group_ids = [
        aws_security_group.no_ingress_all_egress[0].id
      ]
    }
  }

  tags = var.tags
}
