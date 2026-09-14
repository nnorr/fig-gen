// Two-register pipeline stage: a data value and its valid bit, loaded every cycle.
module pipe_valid (
  input  logic       clk,
  input  logic       rst_n,
  input  logic       valid_i,
  input  logic [7:0] data_i,
  output logic       valid_o,
  output logic [7:0] data_o
);
  logic       valid_q;
  logic [7:0] data_q;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      valid_q <= 1'b0;
      data_q  <= 8'd0;
    end else begin
      valid_q <= valid_i;
      data_q  <= data_i + 8'd1;
    end
  end

  assign valid_o = valid_q;
  assign data_o  = data_q;
endmodule
